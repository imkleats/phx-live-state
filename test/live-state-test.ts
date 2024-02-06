import { expect } from "@esm-bundle/chai";
import LiveState from '../src/LiveState';
import { connectElement } from "../src";
import { Channel, type Push } from 'phoenix';
import sinon, { type SinonStub } from 'sinon';
import { html, LitElement } from 'lit';
import { property, customElement, state } from 'lit/decorators.js';
import { fixture } from '@open-wc/testing';
import { compare } from "fast-json-patch";


describe('LiveState', () => {
  let socketMock, liveState, stubChannel, receiveStub;
  beforeEach(() => {
    liveState = new LiveState({url: "wss://foo.com", topic: "stuff"});
    socketMock = sinon.mock(liveState.socketManager.socket);
    receiveStub = sinon.stub();
    receiveStub.withArgs("ok", sinon.match.func).returns({receive: receiveStub});
    stubChannel = sinon.createStubInstance(Channel, {
      join: sinon.stub().returns({
        receive: receiveStub
      }) as sinon.SinonStub<[timeout?: number], Push>,
      on: sinon.spy() as SinonStub<[event: string, callback: (response?: any) => void | Promise<void>], number>,
      push: sinon.spy() as SinonStub<[event: string, payload: object, timeout?: number], Push>
    });
    liveState.socketManager.replaceTopicChannel("stuff", stubChannel)
  });

  it('connects to a socket and channel', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    socketMock.verify();
  });

  xit('sends params from config on channel join', () => {
    liveState.config.params = {bing: 'baz'};
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    socketMock.verify();
  });

  it('does not connect if already connected', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    liveState.connect();
    socketMock.verify();
  });

  it('listens to state changes', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    let state = { foo: 'bar' };
    liveState.addEventListener('livestate-change', ({ detail: {state: {foo}} }) => state.foo = foo);
    expect(liveState.channel.on.callCount).to.equal(3)
    const onArgs = liveState.channel.on.getCall(0).args;
    expect(onArgs[0]).to.equal("state:change");
    const onHandler = onArgs[1];
    onHandler({state: { foo: 'wuzzle' }, version: 0});
    expect(state.foo).to.equal('wuzzle');
    expect(liveState.stateVersion).to.equal(0);
    socketMock.verify();
  });

  it('understands jsonpatch for state changes', () => {
    const initialState = { foo: "bar" };
    const newState = { foo: "baz", bing: [1, 2] };
    const patch = compare(initialState, newState);
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    let state = {};
    let receivedPatch;

    liveState.addEventListener('livestate-change', ({detail: {state: newState}}) => state = newState);
    liveState.addEventListener('livestate-patch', ({detail: {patch: thePatch}}) => receivedPatch = thePatch);

    const onChangeArgs = liveState.channel.on.getCall(0).args;
    expect(onChangeArgs[0]).to.equal("state:change");
    const onChangeHandler = onChangeArgs[1];
    onChangeHandler({state: initialState, version: 0});

    const onPatchArgs = liveState.channel.on.getCall(1).args;
    expect(onPatchArgs[0]).to.equal("state:patch");
    const onPatchHandler = onPatchArgs[1];
    onPatchHandler({patch, version: 1});

    expect(receivedPatch).to.equal(patch);
    expect(state).to.deep.equal(newState);
  });

  it('accepts version number rollover in json patch', () => {
    const initialState = { foo: "bar" };
    const newState = { foo: "baz"};
    const patch = compare(initialState, newState);
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    let state = {};
    let receivedPatch;

    liveState.addEventListener('livestate-change', ({detail: {state: newState}}) => state = newState);
    liveState.addEventListener('livestate-patch', ({detail: {patch: thePatch}}) => receivedPatch = thePatch);

    const onChangeArgs = liveState.channel.on.getCall(0).args;
    expect(onChangeArgs[0]).to.equal("state:change");
    const onChangeHandler = onChangeArgs[1];
    onChangeHandler({state: initialState, version: 1000});

    const onPatchArgs = liveState.channel.on.getCall(1).args;
    expect(onPatchArgs[0]).to.equal("state:patch");
    const onPatchHandler = onPatchArgs[1];
    onPatchHandler({patch, version: 0});

    expect(receivedPatch).to.equal(patch);
    expect(state).to.deep.equal(newState);

  })

  it('requests new state when receiving patch with incorrect version', () => {
    const initialState = { foo: "bar" };
    const newState = { foo: "baz", bing: [1, 2] };
    const patch = compare(initialState, newState);
    socketMock.expects('connect').exactly(1);
    socketMock.expects('channel').exactly(1).returns(stubChannel);
    liveState.connect({ foo: 'bar' });
    let state = {};
    liveState.subscribe(({detail: {state: newState}}) => state = newState);

    const onChangeArgs = liveState.channel.on.getCall(0).args;
    expect(onChangeArgs[0]).to.equal("state:change");
    const onChangeHandler = onChangeArgs[1];
    onChangeHandler({state: initialState, version: 0});

    const onPatchArgs = liveState.channel.on.getCall(1).args;
    expect(onPatchArgs[0]).to.equal("state:patch");
    const onPatchHandler = onPatchArgs[1];
    onPatchHandler({patch, version: 2});

    expect(state).to.deep.equal(initialState);
    const pushCall = liveState.channel.push.getCall(0);
    expect(pushCall.args[0]).to.equal('lvs_refresh');
  });

  it('disconnects', () => {
    socketMock.expects('disconnect').exactly(1)
    liveState.disconnect();
    socketMock.verify();
    expect(liveState.connected).to.be.false;
  });

  it('dispatches custom events over the channel', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    liveState.dispatchEvent(new CustomEvent('sumpinhappend', { detail: { foo: 'bar' } }));
    const pushCall = liveState.channel.push.getCall(0);
    expect(pushCall.args[0]).to.equal('lvs_evt:sumpinhappend');
    expect(pushCall.args[1]).to.deep.equal({ foo: 'bar' });
  });

  it('pushes non custom event events over the channel', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    liveState.pushEvent('sumpinhappend', { foo: 'bar' });
    const pushCall = liveState.channel.push.getCall(0);
    expect(pushCall.args[0]).to.equal('lvs_evt:sumpinhappend');
    expect(pushCall.args[1]).to.deep.equal({ foo: 'bar' });
  });

  it('sends errors to subscribers', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    const errorHandler = receiveStub.getCall(1).args[1];
    let errorType, errorMessage;
    liveState.addEventListener('livestate-error', ({detail: {type, message}}) => {
      errorType = type;
      errorMessage = message;
    });
    errorHandler({reason: 'unmatched topic'});
    expect(errorType).to.equal('channel join error');
    expect(errorMessage).to.equal('unmatched topic');
  });

  it('does not error when sending errors', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    const errorHandler = receiveStub.getCall(1).args[1];
    let errorType, errorMessage;
    liveState.addEventListener('livestate-error', ({detail: {type, message}}) => {
      errorType = type;
      errorMessage = message;
    });
    errorHandler();
    expect(errorType).to.equal('channel join error');
  });

  it('receives errors from server', () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();
    expect(liveState.channel.on.callCount).to.equal(3)
    const onArgs = liveState.channel.on.getCall(2).args;
    expect(onArgs[0]).to.equal("error");
    const onHandler = onArgs[1];
    let errorType, errorMessage;
    liveState.addEventListener('livestate-error', ({detail: {type, message}}) => {
      errorType = type;
      errorMessage = message;
    });
    onHandler({type: "server error", message: "sumpin bad happened"});
    expect(errorType).to.equal('server error');
    expect(errorMessage).to.equal('sumpin bad happened');
  })

  it('addEventListenter receives events from channel', async () => {
    socketMock.expects('connect').exactly(1);
    liveState.connect();

    let eventDetail;
    liveState.addEventListener('sayHiBack', ({ detail }: CustomEvent) => { eventDetail = detail });

    const onArgs = liveState.channel.on.getCall(3).args;
    expect(onArgs[0]).to.equal("sayHiBack")
    const onHandler = onArgs[1];
    onHandler({ foo: 'bar' })
    expect(eventDetail).to.deep.equal({ foo: 'bar' });
  });


});