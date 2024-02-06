import { Socket, type Channel, type Push } from "phoenix";
import type { LiveState, LiveStateError } from "./LiveState";

export type SocketManagerConfig = {
  /** An existing Phoenix Socket connection may be passed. */
  socket?: Socket;

  /** The end point to connect to, should be a websocket url (ws or wss) */
  url?: string;

  /** the options passed to the phoenix socket */
  socketOptions?: object;
};

/**
 * StateChannel is data type used internally by the SocketManager
 * to store information about a topic, its associated Channel, and
 * the LiveState instance currently using that Channel.
 */
export type StateChannel = {
  /** The topic for the channel */
  topic: string;

  /** will be sent as params on channel join */
  params?: object;

  /** the actual Phoenix Channel */
  channel: Channel;

  /** the LiveState instance using this channel */
  liveState?: LiveState;

  /** keepAlive dictates when topics and channels are closed after being checked
   * in by the attached LiveState instance.
   *
   * - when keepAlive is set to `false` (or undefined -- default), the Channel
   *   is immediately closed
   * - when keepAlive is set to `true`, the Channel remains open indefinitely.
   * - when keepAlive is set to a positive integer, that value is the time in
   *   milliseconds before the Channel will be closed.
   *
   * Not too sure about this implementation or the need for it at the moment.
   */
  keepAlive?: boolean | number;
  keepAliveRef?: ReturnType<typeof setTimeout>;
};

/**
 * This is a lower level API for interfacing with Phoenix Socket and Phoenix Channel
 * primitives and managing those resources for use by LiveState. The SocketManager
 * keeps track of which Channels are used by which LiveState instances by providing
 * a fairly naive check-in/check-out mechanism backed by a Map of used Topics, which
 * have a strong one-to-one relationship with a single Channel and LiveState instance.
 * 
 * A primary goal was to multiplex LiveState instances over a single socket, and it does
 * that despite its warts. This should be refactored to more cleanly establish responsibility 
 * boundaries between the central SocketManager and the LiveState itself... and I'm not 
 * crazy about the name.
 */
export class SocketManager {
  status: "disconnected" | "connected";
  config: SocketManagerConfig;
  socket: Socket;
  ownSocket: boolean;
  channelMap: Map<string, StateChannel> = new Map();
  keepAlive: boolean = false;

  constructor(config: SocketManagerConfig) {
    this.config = config;
    this.socket =
      config.socket ||
      new Socket(
        this.config.url,
        this.config.socketOptions || {
          logger: (kind, msg, data) => {
            console.debug(`${kind}: ${msg}`, data);
          },
        }
      );
    this.ownSocket = this.socket !== config.socket;
    this.status = this.socket.isConnected() ? "connected" : "disconnected";
  }

  get connected(): boolean {
    return this.status === "connected";
  }
  /** connect to socket will do nothing if already connected */
  connect() {
    if (!this.connected) {
      if (!this.socket.isConnected()) {
        this.socket.onError((e) => this.handleError("socket error", e));
        this.socket.connect();
      }
      this.status = "connected";
    }
  }

  /** Disconnect from socket unless the socket does not belong to the LiveState instance.
   * Otherwise clean up LiveState Channels opened on the borrowed socket.
   * */
  disconnect() {
    this.channelMap.forEach((stateChannel, _topic) => {
      stateChannel.channel.leave();
    });
    if (this.ownSocket) this.socket.disconnect();
    this.status = "disconnected";
  }

  /** mostly added for swapping in mock channels on tests */
  replaceTopicChannel(topic: string, newChannel: Channel) {
    const stateChannel = this.channelMap.get(topic);
    if (!stateChannel) return;
    stateChannel.channel = newChannel;
    stateChannel.liveState.channel = stateChannel.channel;
  }

  setLiveStateListeners(liveState: LiveState, channel: Channel) {
    channel.onError((e) => liveState.emitError("channel error", e));
    channel.on("state:change", (state) => liveState.handleChange(state));
    channel.on("state:patch", (patch) => liveState.handlePatch(patch));
    channel.on("error", (error) => liveState.emitServerError(error));
  }

  checkOutChannel(
    topic: string,
    params: object,
    liveState: LiveState,
    callback?: (push: Push) => void
  ) {
    if (this.channelMap.has(topic)) {
      // The topic already has a StateChannel

      const stateChannel = this.channelMap.get(topic);
      if (!stateChannel.liveState && stateChannel.channel) {
        // handle unoccupied StateChannel

        // Reset the keepAlive timeout
        clearTimeout(stateChannel.keepAliveRef);
        stateChannel.keepAliveRef = null;

        // Assign the LiveState instance to the StateChannel
        stateChannel.liveState = liveState;

        return stateChannel.channel;
      } else if (stateChannel.liveState !== liveState) {
        // handle existing LiveState tenant for the StateChannel
        liveState.emitError(
          "channel error",
          new Error(
            `channel for topic (${topic}) already checked out by another LiveState instance.`
          )
        );
        return null;
      } else {
        // When the StateChannel is already owned by the LiveState, return its channel.
        return stateChannel.channel;
      }
    } else {
      // The topic does not have a StateChannel

      // create the new Phoenix Channel
      const channel = this.socket.channel(topic, params);

      // add the new StateChannel to the channelMap
      this.channelMap.set(
        topic,
        this.newStateChannel({
          topic,
          params,
          channel,
          liveState,
        })
      );
      
      return channel;
    }
  }

  newStateChannel({ topic, params, channel, liveState }) {
    return Object.assign(Object.create(null), {
      topic,
      params,
      channel,
      liveState,
    });
  }

  channelCheckedOutBy(topic: string, liveState: LiveState) {
    return Array.from(this.channelMap.entries()).some(
      ([channelTopic, stateChannel]) => {
        return channelTopic === topic && stateChannel.liveState == liveState;
      }
    );
  }

  checkInChannel(topic: string, channel: Channel, liveState: LiveState) {
    if (this.channelMap.has(topic)) {
      const stateChannel = this.channelMap.get(topic);
      if (
        stateChannel.channel == channel &&
        stateChannel.liveState == liveState
      ) {
        if (stateChannel.keepAlive) {
          // Remove LiveState from StateChannel
          stateChannel.liveState = null;

          if (typeof stateChannel.keepAlive == "number") {
            // setTimeout to clean up the StateChannel
            stateChannel.keepAliveRef = setTimeout(() => {
              this.removeStateChannel(stateChannel);
            }, stateChannel.keepAlive);
          }
          // base case `stateChannel.keepAlive = true`, do nothing extra
        } else {
          // StateChannel.keepAlive = falsey, so we remove it.
          this.removeStateChannel(stateChannel);
        }
      } else {
        // mismatch between Channel being checked in and the StateChannel
        // for the given topic *OR* the LiveState instances assigned to that StateChannel.
        liveState.emitError(
          "channel error",
          new Error(`cannot check in channel for topic (${topic})`)
        );
      }
    } else {
      // the channelMap doesn't have a record for the topic/Channel being checked in
      liveState.emitError(
        "channel error",
        new Error(`cannot check in channel for topic (${topic})`)
      );
    }
    return this;
  }

  removeStateChannel(stateChannel: StateChannel) {
    stateChannel.channel.leave();
    this.channelMap.delete(stateChannel.topic);
    if (this.channelMap.size == 0) {
      this.keepAlive || this.disconnect();
    }
    return this;
  }

  handleError(type, error) {
    dispatchEvent(
      new CustomEvent<LiveStateError>("livestate-error", {
        detail: {
          type,
          message: this.extractMessage(error),
        },
      })
    );
  }

  extractMessage(error) {
    if (error && typeof (error == "object")) {
      const message = [error.reason, error.name, error.message].find(
        (value) => value
      );
      console.log(message);
      return message;
    } else if (typeof error == "string") {
      return error;
    }
  }
}

export default SocketManager;
