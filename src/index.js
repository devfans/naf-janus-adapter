var mj = require("minijanus");
var sdpUtils = require("sdp");
var debug = require("debug")("naf-janus-adapter:debug");
var warn = require("debug")("naf-janus-adapter:warn");
var error = require("debug")("naf-janus-adapter:error");
var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const SUBSCRIBE_TIMEOUT_MS = 15000;

const AVAILABLE_OCCUPANTS_THRESHOLD = 5;
const MAX_SUBSCRIBE_DELAY = 5000;

function dispose(state) {
  if (state.conn) {
    state.conn.close();
  }
  state.conn = null;
  state.handle = null;
  state.mediaStream = null;
}

function randomDelay(min, max) {
  return new Promise(resolve => {
    const delay = Math.random() * (max - min) + min;
    setTimeout(resolve, delay);
  });
}

function debounce(fn) {
  var curr = Promise.resolve();
  return function() {
    var args = Array.prototype.slice.call(arguments);
    curr = curr.then(_ => fn.apply(this, args));
  };
}

function randomUint() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

function untilDataChannelOpen(dataChannel) {
  return new Promise((resolve, reject) => {
    if (dataChannel.readyState === "open") {
      resolve();
    } else {
      let resolver, rejector;

      const clear = () => {
        dataChannel.removeEventListener("open", resolver);
        dataChannel.removeEventListener("error", rejector);
      };

      resolver = () => {
        clear();
        resolve();
      };
      rejector = () => {
        clear();
        reject();
      };

      dataChannel.addEventListener("open", resolver);
      dataChannel.addEventListener("error", rejector);
    }
  });
}

const isH264VideoSupported = (() => {
  const video = document.createElement("video");
  return video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "";
})();

const OPUS_PARAMETERS = {
  // indicates that we want to enable DTX to elide silence packets
  usedtx: 1,
  // indicates that we prefer to receive mono audio (important for voip profile)
  stereo: 0,
  // indicates that we prefer to send mono audio (important for voip profile)
  "sprop-stereo": 0
};

const DEFAULT_PEER_CONNECTION_CONFIG = {
  iceServers: [{ urls: "stun:stun1.l.google.com:19302" }, { urls: "stun:stun2.l.google.com:19302" }]
};

const WS_NORMAL_CLOSURE = 1000;

class JanusPublisher {
  constructor(room) {
    this.room = room.room
    this.clientId = room.clientId
    this.joinToken = room.joinToken
    this.session = room.session
    this.handle = room.handle
    this.conn = room.conn

    console.log("Constrcucting room publisher to room " + room.room);
  }

  sendJoin(subscribe) {
    console.log("Joining extra room " + this.room);
    return this.handle.sendMessage({
      kind: "join",
      room_id: this.room,
      user_id: this.clientId,
      subscribe,
      token: this.joinToken
    });
  }
}

class JanusSession {
  constructor(room) {
    this.serverUrl = room.serverUrl
    this.ws = null
    this.session = null
    this.webRtcOptions = room.webRtcOptions
    this.peerConnectionConfig = room.peerConnectionConfig
    this.joinToken = room.joinToken
    this.localMediaStream = room.localMediaStream || null

    this.initialReconnectionDelay = 1000 * Math.random();
    this.reconnectionDelay = this.initialReconnectionDelay;
    this.reconnectionTimeout = null;
    this.maxReconnectionAttempts = 1000;
    this.reconnectionAttempts = 0;

    // this._publishers = {}
    if (NAF._stream_upstream) this._publisher = new JanusPublisher(room)

    this.active = false
    console.log("Constructing janus session to " + room.serverUrl);

    this.pendingSubscribers = []
  }

  listenForActive(res) {
    if (this.active) return res()
    else this.pendingSubscribers.push(res)
  }

  setWebRtcOptions(options) {
    this.webRtcOptions = options;
  }

  setPeerConnectionConfig(peerConnectionConfig) {
    this.peerConnectionConfig = peerConnectionConfig;
  }

  async getOrCreatePublisher(room) {
    /*
    if (!this._publishers[room.room]) {
      this._publishers[room.room] = await this.createExtraPublisher(room)
    }
    */
    if (this._publisher && room.room == this._publisher.room) return this._publisher
    this._publisher = new JanusPublisher(room)
    return this._publisher
  }

  associate(state) {
    state.conn.addEventListener("icecandidate", ev => {
      // console.log("extra icecandidate");
      state.handle.sendTrickle(ev.candidate || null).catch(e => error("Error trickling ICE: %o", e));
    });
    state.conn.addEventListener("iceconnectionstatechange", ev => {
      // console.log("extra iceconnectionstatechange");
      if (state.conn.iceConnectionState === "failed") {
        console.warn("ICE failure detected. Reconnecting in 10s.");
        console.info("Delayed reconnect for extra session!");
        this.performDelayedReconnect();
      }
    })

    // we have to debounce these because janus gets angry if you send it a new SDP before
    // it's finished processing an existing SDP. in actuality, it seems like this is maybe
    // too liberal and we need to wait some amount of time after an offer before sending another,
    // but we don't currently know any good way of detecting exactly how long :(
    state.conn.addEventListener(
      "negotiationneeded",
      debounce(ev => {
        // console.log("extra negotiationneeded");
        debug("Sending new offer for handle: %o", state.handle);
        var offer = state.conn.createOffer().then(this.configurePublisherSdp).then(this.fixSafariIceUFrag);
        var local = offer.then(o => state.conn.setLocalDescription(o));
        var remote = offer;

        remote = remote
          .then(this.fixSafariIceUFrag)
          .then(j => state.handle.sendJsep(j))
          .then(r => state.conn.setRemoteDescription(r.jsep));
        return Promise.all([local, remote]).catch(e => error("Error negotiating offer: %o", e));
      })
    );
    state.handle.on(
      "event",
      debounce(ev => {
        var jsep = ev.jsep;
        if (jsep && jsep.type == "offer") {
          debug("Accepting new offer for handle: %o", state.handle);
          var answer = state.conn
            .setRemoteDescription(this.configureSubscriberSdp(jsep))
            .then(_ => state.conn.createAnswer())
            .then(this.fixSafariIceUFrag);
          var local = answer.then(a => state.conn.setLocalDescription(a));
          var remote = answer.then(j => state.handle.sendJsep(j));
          return Promise.all([local, remote]).catch(e => error("Error negotiating answer: %o", e));
        } else {
          // some other kind of event, nothing to do
          return null;
        }
      })
    );
  }

  configurePublisherSdp(jsep) {
    jsep.sdp = jsep.sdp.replace(/a=fmtp:(109|111).*\r\n/g, (line, pt) => {
      const parameters = Object.assign(sdpUtils.parseFmtp(line), OPUS_PARAMETERS);
      return sdpUtils.writeFmtp({ payloadType: pt, parameters: parameters });
    });
    return jsep;
  }

  configureSubscriberSdp(jsep) {
    // todo: consider cleaning up these hacks to use sdputils
    if (!isH264VideoSupported) {
      if (navigator.userAgent.indexOf("HeadlessChrome") !== -1) {
        // HeadlessChrome (e.g. puppeteer) doesn't support webrtc video streams, so we remove those lines from the SDP.
        jsep.sdp = jsep.sdp.replace(/m=video[^]*m=/, "m=");
      }
    }

    // TODO: Hack to get video working on Chrome for Android. https://groups.google.com/forum/#!topic/mozilla.dev.media/Ye29vuMTpo8
    if (navigator.userAgent.indexOf("Android") === -1) {
      jsep.sdp = jsep.sdp.replace(
        "a=rtcp-fb:107 goog-remb\r\n",
        "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n"
      );
    } else {
      jsep.sdp = jsep.sdp.replace(
        "a=rtcp-fb:107 goog-remb\r\n",
        "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n"
      );
    }
    return jsep;
  }

  async fixSafariIceUFrag(jsep) {
    // Safari produces a \n instead of an \r\n for the ice-ufrag. See https://github.com/meetecho/janus-gateway/issues/1818
    jsep.sdp = jsep.sdp.replace(/[^\r]\na=ice-ufrag/g, "\r\na=ice-ufrag");
    return jsep
  }

  async connect() {
    this.active = false;
    debug(`connecting to ${this.serverUrl}`);

    const websocketConnection = new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl, "janus-protocol");

      console.log("Init extra session");
      this.session = new mj.JanusSession(this.ws.send.bind(this.ws), { timeoutMs: 30000 });
      // console.dir({ session: this.session })
      console.log("Connecting to extra janus server " + this.serverUrl);

      let onOpen;

      const onError = () => {
        reject(error);
      };

      this.ws.addEventListener("close", this.onWebsocketClose.bind(this));
      this.ws.addEventListener("message", this.onWebsocketMessage.bind(this));

      onOpen = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
        this.onWebsocketOpen()
          .then(resolve)
          .catch(reject);
      };

      this.ws.addEventListener("open", onOpen);
    });

    // return Promise.all([websocketConnection, this.updateTimeOffset()]);
    await websocketConnection;
    this.active = true;
  }

  disconnect() {
    debug(`disconnecting`);

    clearTimeout(this.reconnectionTimeout);

    // this.removeAllOccupants();
    // this.leftOccupants = new Set();

    /*
    Object.keys(this._publishers).forEach( room => {
      // Close the publisher peer connection. Which also detaches the plugin handle.
      if (this._publishers[room]) {
        if (this._publishers[room].conn) this._publishers[room].conn.close();
        this._publishers[room] = null
      }
    })*/
    if (this._publisher) {
        dispose(this._publisher);
        if (this._publisher.conn) this._publisher.conn.close();
    }

    if (this.session) {
      this.session.dispose();
      this.session = null;
    }

    if (this.ws) {
      this.ws.removeEventListener("open", this.onWebsocketOpen);
      this.ws.removeEventListener("close", this.onWebsocketClose);
      this.ws.removeEventListener("message", this.onWebsocketMessage);
      this.ws.close();
      this.ws = null;
    }
  }

  isDisconnected() {
    return this.ws === null;
  }

  async onWebsocketOpen() {
    // Create the Janus Session
    console.log("Extra janus session open for " + this.serverUrl);
    await this.session.create();
    console.log("setting session as active")

    this.active = true;
    this.pendingSubscribers.forEach(res => res())
    this.pendingSubscribers = []

    if (this.reconnectHandler) this.reconnectHandler()

    if (this._publisher) this._publisher = await this.createExtraPublisher({
      room: this._publisher.room,
      clientId: this._publisher.clientId,
      joinToken: this._publisher.joinToken
    })
    /*
    Object.keys(this._publishers).forEach(async (id) => {
      const room = {
        room: id,
        clientId: this._publishers[id].clientId,
        joinToken: this._publishers[id].joinToken
      }
      this._publishers[id] = await this.createExtraPublisher(room)
    })
    */

    // Attach the SFU Plugin and create a RTCPeerConnection for the publisher.
    // The publisher sends audio and opens two bidirectional data channels.
    // One reliable datachannel and one unreliable.
    // this.publisher = await this.createPublisher();

    // Call the naf connectSuccess callback before we start receiving WebRTC messages.
    // this.connectSuccess(this.clientId);

    /*
    const addOccupantPromises = [];

    for (let i = 0; i < this.publisher.initialOccupants.length; i++) {
      const occupantId = this.publisher.initialOccupants[i];
      if (occupantId === this.clientId) continue; // Happens during non-graceful reconnects due to zombie sessions
      addOccupantPromises.push(this.addOccupant(occupantId));
    }

    await Promise.all(addOccupantPromises);
    */
  }

  onWebsocketClose(event) {
    this.active = false
    console.error("Extra session ws is closing!");
    // The connection was closed successfully. Don't try to reconnect.
    if (event.code === WS_NORMAL_CLOSURE) {
      return;
    }

    if (this.onReconnecting) {
      this.onReconnecting(this.reconnectionDelay);
    }

    this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
  }

  reconnect() {
    console.log("Extra session reconnecting")
    // Dispose of all networked entities and other resources tied to the session.
    this.disconnect();

    this.connect()
      .then(() => {
        this.reconnectionDelay = this.initialReconnectionDelay;
        this.reconnectionAttempts = 0;

        if (this.onReconnected) {
          console.log("Extra session reconnected")
          this.onReconnected();
        }
      })
      .catch(error => {
        this.reconnectionDelay += 1000;
        this.reconnectionAttempts++;

        if (this.reconnectionAttempts > this.maxReconnectionAttempts && this.onReconnectionError) {
          return this.onReconnectionError(
            new Error("Connection could not be reestablished, exceeded maximum number of reconnection attempts.")
          );
        }

        console.warn("Error during reconnect, retrying.");
        console.warn(error);

        if (this.onReconnecting) {
          this.onReconnecting(this.reconnectionDelay);
        }

        this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
      });
  }

  performDelayedReconnect() {
    if (this.delayedReconnectTimeout) {
      clearTimeout(this.delayedReconnectTimeout);
    }

    this.delayedReconnectTimeout = setTimeout(() => {
      this.delayedReconnectTimeout = null;
      this.reconnect();
    }, 10000);
  }

  onWebsocketMessage(event) {
    // console.log("extra session message");
    // console.dir({ event, session: this.session }, { depth: null});
    if (this.session) this.session.receive(JSON.parse(event.data));
  }

  setLocalMediaStream(stream) {
    this.localMediaStream  = stream;
    if (!this._publisher) return

    [this._publisher].forEach(async pub => {
      if (!pub) return
      if (pub.conn) {
        /*
        this.localMediaStream.getTracks().forEach(track => {
          pub.conn.addTrack(track, this.localMediaStream);
        });
        */

        const existingSenders = pub.conn.getSenders();
        const newSenders = [];
        const tracks = stream.getTracks();

        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          const sender = existingSenders.find(s => s.track != null && s.track.kind == t.kind);

          if (sender != null) {
            if (sender.replaceTrack) {
              await sender.replaceTrack(t);

              // Workaround https://bugzilla.mozilla.org/show_bug.cgi?id=1576771
              if (t.kind === "video" && t.enabled && navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                t.enabled = false;
                setTimeout(() => t.enabled = true, 1000);
              }
            } else {
              // Fallback for browsers that don't support replaceTrack. At this time of this writing
              // most browsers support it, and testing this code path seems to not work properly
              // in Chrome anymore.
              stream.removeTrack(sender.track);
              stream.addTrack(t);
            }
            newSenders.push(sender);
          } else {
            newSenders.push(pub.conn.addTrack(t, stream));
          }
        }
        existingSenders.forEach(s => {
          if (!newSenders.includes(s)) {
            s.track.enabled = false;
          }
        });
      }
    })
  }

  async createExtraPublisher(room) {
    if (!this.active) return new JanusPublisher(room);
    // console.dir(this.peerConnectionConfig, {depth: null})
    const state = {
      handle: new mj.JanusPluginHandle(this.session),
      conn: new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG)
    };

    await handle.attach("janus.plugin.sfu");

    this.associate(state);

    debug("pub waiting for data channels & webrtcup");
    var webrtcup = new Promise(resolve => state.handle.on("webrtcup", resolve));

    var reliableChannel = state.conn.createDataChannel("reliable", { ordered: true });
    var unreliableChannel = state.conn.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0
    });

    // reliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-reliable"));
    // unreliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-unreliable"));

    await webrtcup;
    console.log("webrtcup for extra rooms")
    await untilDataChannelOpen(reliableChannel);
    await untilDataChannelOpen(unreliableChannel);

    // doing this here is sort of a hack around chrome renegotiation weirdness --
    // if we do it prior to webrtcup, chrome on gear VR will sometimes put a
    // renegotiation offer in flight while the first offer was still being
    // processed by janus. we should find some more principled way to figure out
    // when janus is done in the future.
    if (this.localMediaStream) {
      this.localMediaStream.getTracks().forEach(track => {
        state.conn.addTrack(track, this.localMediaStream);
      });
    }

    // Handle all of the join and leave events.
    state.handle.on("event", ev => {
      console.log("event on new extra publisher ")
      // console.dir(ev, { depth: null});
      return
      var data = ev.plugindata.data;
      if (data.event == "join" && data.room_id == this.room) {
        this.addOccupant(data.user_id);
      } else if (data.event == "leave" && data.room_id == this.room) {
        this.removeOccupant(data.user_id);
      } else if (data.event == "blocked") {
        document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: data.by } }));
      } else if (data.event == "unblocked") {
        document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: data.by } }));
      } else if (data.event === "data") {
        this.onData(JSON.parse(data.body), "janus-event");
      }
    });

    debug("pub waiting for join");

    room.handle = state.handle
    room.conn = state.conn
    const publisher = new JanusPublisher(room)

    // Send join message to janus. Listen for join/leave messages. Automatically subscribe to all users' WebRTC data.
    var message = await publisher.sendJoin({
      notifications: true,
      data: true
    });

    if (!message.plugindata || !message.plugindata.data.success) {
      const err = message.plugindata.data.error;
      console.error(err);
      throw err;
    }

    /*
    var initialOccupants = message.plugindata.data.response.users[this.room] || [];

    if (initialOccupants.includes(this.clientId)) {
      console.warn("Janus still has previous session for this client. Reconnecting in 10s.");
      this.performDelayedReconnect();
    }*/

    console.log("publisher " + room.room + " ready");
    /*
    return {
      handle,
      initialOccupants: [],
      reliableChannel: null,
      unreliableChannel: null,
      conn
    };
    */
    return publisher
  }
}


class JanusAdapter {
  constructor() {
    this.room = null;
    // We expect the consumer to set a client id before connecting.
    this.clientId = null;
    this.joinToken = null;

    this.serverUrl = null;
    this.webRtcOptions = {};
    this.peerConnectionConfig = null;
    this.ws = null;
    this.session = null;
    this.reliableTransport = "datachannel";
    this.unreliableTransport = "datachannel";

    // In the event the server restarts and all clients lose connection, reconnect with
    // some random jitter added to prevent simultaneous reconnection requests.
    this.initialReconnectionDelay = 1000 * Math.random();
    this.reconnectionDelay = this.initialReconnectionDelay;
    this.reconnectionTimeout = null;
    this.maxReconnectionAttempts = 10;
    this.reconnectionAttempts = 0;

    this.publisher = null;
    this.occupantIds = [];
    this.occupants = {};
    this.mediaStreams = {};
    this.localMediaStream = null;
    this.pendingMediaRequests = new Map();

    this.pendingOccupants = new Set();
    this.availableOccupants = [];
    this.requestedOccupants = null;

    this.blockedClients = new Map();
    this.frozenUpdates = new Map();

    this.timeOffsets = [];
    this.serverTimeRequests = 0;
    this.avgTimeOffset = 0;

    this.onWebsocketOpen = this.onWebsocketOpen.bind(this);
    this.onWebsocketClose = this.onWebsocketClose.bind(this);
    this.onWebsocketMessage = this.onWebsocketMessage.bind(this);
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
    this.onData = this.onData.bind(this);

    this._publishers = {}
    this._sessions = {}
    this.mainRooms = []
    this.extraRooms = {}
    this.upstreamParams = {}

    if (NAF._solution == 2) window.addEventListener('guestspeaker_update', this.updateSpeakerSource.bind(this));
  }

  updateSpeakerSource () {
  }

  async setExtraRooms() {
    let publishers = {}
    const rooms = []
    Object.entries(this.extraRooms).forEach(([serverUrl, room]) => {
      rooms.push({ serverUrl, room })
    });
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i]
      room.peerConnectionConfig = this.peerConnectionConfig
      room.joinToken =  this.joinToken
      room.clientId = this.clientId
      room.webRtcOptions = this.webRtcOptions
      room.localMediaStream = this.localMediaStream

      if (room.serverUrl == this.serverUrl) {
        console.log("Unexpected same janus server for this room " + room.room);
        // console.log("current room " + this.room);
        // if (room.room != this.room) publishers[room.room] = await this.getOrCreatePublisher(room)
      } else {
        console.log("Finding janus session for this room " + room.room);
        const session = this.getOrCreateSession(room);
        publishers[room.room] = await session.getOrCreatePublisher(room)
      }
    }

    this._publishers = publishers
  }

  async initUpstream() {
    console.log("Initializing upstream room")
    const meta = await NAF._upstream_meta;
    Object.assign(this.upstreamParams, meta||{})
    const room =  {};
    Object.assign(room, this.upstreamParams);
    room.webRtcOptions = this.webRtcOptions
    room.localMediaStream = this.localMediaStream
    // const session = this.getOrCreateSession(room)
    this._upstream_room = room
    console.log("upstream info")
    console.dir(room)
    this._upstream_session = new JanusSession(room)
    // const update = subscribe.bind(this)
    const update = this.syncOccupants.bind(this);
    window.addEventListener('upstream_update', () => update());
    this._upstream_session.reconnectHandler = this.syncOccupants.bind(this)
    this._upstream_session_ready = true;
    this._upstream_session.connect()
    this.syncOccupants();
    // if (this.timer) clearInterval(this.timer)
    // this.timer = setInterval(update, 5000)
  }

  async configExtraRooms() {
    console.log("Configuring extra rooms")
    // const raw = await fetch('https://mcc-api.mcc-vr.link/auth?email=' + window.APP.store.state.credentials.email + "&room=" +  window.APP.hubChannel.hubId).then(d=>d.json())
    const raw = NAF._hubs_meta
    console.log("is speaker: " + raw.is_speaker)
    // window.APP.store._meta = raw

    this.extraRooms = {}
    this.mainRooms = [ this.room ]
    if (NAF._stream_upstream && raw && raw.is_speaker) {
      console.log("Setting extra rooms for " + window.APP.store.identityName);
      // this.setExtraRooms(rooms);
      Object.keys(raw.rooms).forEach(server => {
        if (server == this.serverUrl) {
          const mainRooms = new Set([ ...(raw.rooms[server])])
          mainRooms.delete(this.room)
          this.mainRooms = [this.room, ...mainRooms]
        } else  {
          this.extraRooms[server] = [...new Set(raw.rooms[server])].join('-')
        }
      })
    }

    this.setExtraRooms();
  }

  async addUpstreamOccupant(occupantId) {
    if (!this._upstream_session_ready) return;
    console.log("Subscribing to upstream" + occupantId);
    this.pendingOccupants.add(occupantId);
    
    const availableOccupantsCount = this.availableOccupants.length;
    if (availableOccupantsCount > AVAILABLE_OCCUPANTS_THRESHOLD) {
      await randomDelay(0, MAX_SUBSCRIBE_DELAY);
    }
  
    const subscriber = await this.createUpstreamSubscriber(occupantId);
    if (subscriber) {
      if(!this.pendingOccupants.has(occupantId)) {
        dispose(subscriber);
      } else {
        this.pendingOccupants.delete(occupantId);
        this.occupantIds.push(occupantId);
        this.occupants[occupantId] = subscriber;

        this.setMediaStream(occupantId, subscriber.mediaStream);

        // Call the Networked AFrame callbacks for the new occupant.
        this.onOccupantConnected(occupantId);
        return true;
      }
    } else this.pendingOccupants.delete(occupantId);
    return false;
  }

  async getOrCreatePublisher(room) {
    if (!this._publishers[room.room]) {
      console.log("Will create janus extra publisher for room " + room.room);
      this._publishers[room.room] = await this.joinExtraRoom(room)
    }
    return this._publishers[room.room]
  }

  getOrCreateSession (room) {
    if (!this._sessions[room.serverUrl]) {
      const session = new JanusSession(room)
      session.connect()
      this._sessions[room.serverUrl] = session
    }
    return this._sessions[room.serverUrl]
  }

  setupUpstream() {
    console.log("Setting extra rooms for " + window.APP.store.identityName);
    if (NAF._stream_upstream) this.setExtraRooms();
    else if (NAF._stream_jmr_downstream) this.initUpstream();
  }

  async createUpstreamSubscriber(occupantId, maxRetries = 5) {
    if (this.availableOccupants.indexOf(occupantId) === -1) {
      console.warn(occupantId + ": cancelled occupant connection, occupant left before subscription negotation.");
      return null;
    }

    await new Promise(res => this._upstream_session.listenForActive(res));
    console.log("Creating subscription for " + occupantId);
    const state = {
      handle: new mj.JanusPluginHandle(this._upstream_session.session),
      conn: new RTCPeerConnection(this.upstreamParams.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG)
    };

    debug(occupantId + ": sub waiting for sfu");
    await state.handle.attach("janus.plugin.sfu");

    this._upstream_session.associate(state);

    debug(occupantId + ": sub waiting for join");

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancelled occupant connection, occupant left after attach");
      return null;
    }

    let webrtcFailed = false;

    const webrtcup = new Promise(resolve => {
      const leftInterval = setInterval(() => {
        if (this.availableOccupants.indexOf(occupantId) === -1) {
          clearInterval(leftInterval);
          resolve();
        }
      }, 1000);

      const timeout = setTimeout(() => {
        clearInterval(leftInterval);
        webrtcFailed = true;
        resolve();
      }, SUBSCRIBE_TIMEOUT_MS);

      state.handle.on("webrtcup", () => {
        clearTimeout(timeout);
        clearInterval(leftInterval);
        resolve();
      });
    });

    // Send join message to janus. Don't listen for join/leave messages. Subscribe to the occupant's media.
    // Janus should send us an offer for this occupant's media in response to this.
    await this.sendUpstreamJoin(state.handle, { media: occupantId });

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancelled occupant connection, occupant left after join");
      return null;
    }

    debug(occupantId + ": sub waiting for webrtcup");
    await webrtcup;

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancel occupant connection, occupant left during or after webrtcup");
      return null;
    }

    if (webrtcFailed) {
      dispose(state);
      if (maxRetries > 0) {
        console.warn(occupantId + ": webrtc up timed out, retrying");
        return this.createUpstreamSubscriber(occupantId, maxRetries - 1);
      } else {
        console.warn(occupantId + ": webrtc up timed out");
        return null;
      }
    }

    if (isSafari && !this._iOSHackDelayedInitialPeer) {
      // HACK: the first peer on Safari during page load can fail to work if we don't
      // wait some time before continuing here. See: https://github.com/mozilla/hubs/pull/1692
      await (new Promise((resolve) => setTimeout(resolve, 3000)));
      this._iOSHackDelayedInitialPeer = true;
    }

    var mediaStream = new MediaStream();
    var receivers = state.conn.getReceivers();
    receivers.forEach(receiver => {
      if (receiver.track) {
        mediaStream.addTrack(receiver.track);
      }
    });
    if (mediaStream.getTracks().length === 0) {
      mediaStream = null;
    }

    debug(occupantId + ": subscriber ready");
    state.mediaStream = mediaStream;
    return state;
  }

  sendUpstreamJoin(handle, subscribe) {
    console.log("Janus upstream joining " + this._upstream_room.room);
    return handle.sendMessage({
      kind: "join",
      room_id: this._upstream_room.room,
      user_id: this.upstreamParams.clientId,
      subscribe,
      token: this.upstreamParams.joinToken
    });
  }

  setServerUrl(url) {
    this.serverUrl = url;
  }

  setApp(app) {}

  setRoom(roomName) {
    this.room = roomName;
  }

  setJoinToken(joinToken) {
    this.joinToken = joinToken;
    if (NAF._stream_upstream) Object.values(this._publishers).forEach(pub => {
      pub.joinToken = joinToken
    });
    if (NAF._stream_jmr_downstream) this.setUpstreamJoinToken(joinToken);
  }

  setUpstreamJoinToken(joinToken) {
    this.upstreamParams.joinToken = joinToken;
  }

  setClientId(clientId) {
    this.clientId = clientId;
    Object.values(this._publishers).forEach(pub => {
      pub.clientId = clientId
    })
  }

  setWebRtcOptions(options) {
    this.webRtcOptions = options;
    Object.values(this._sessions).forEach(sess => {
      sess.webRtcOptions = options
    })
  }

  setPeerConnectionConfig(peerConnectionConfig) {
    this.peerConnectionConfig = peerConnectionConfig;
    Object.values(this._sessions).forEach(sess => {
      sess.peerConnectionConfig = peerConnectionConfig;
    })
  }

  setUpstreamPeerConnectionConfig(peerConnectionConfig) {
    this.upstreamParams.peerConnectionConfig = peerConnectionConfig;
  }

  setServerConnectListeners(successListener, failureListener) {
    this.connectSuccess = successListener;
    this.connectFailure = failureListener;
  }

  setRoomOccupantListener(occupantListener) {
    this.onOccupantsChanged = occupantListener;
  }

  setDataChannelListeners(openListener, closedListener, messageListener) {
    this.onOccupantConnected = openListener;
    this.onOccupantDisconnected = closedListener;
    this.onOccupantMessage = messageListener;
  }

  setReconnectionListeners(reconnectingListener, reconnectedListener, reconnectionErrorListener) {
    // onReconnecting is called with the number of milliseconds until the next reconnection attempt
    this.onReconnecting = reconnectingListener;
    // onReconnected is called when the connection has been reestablished
    this.onReconnected = reconnectedListener;
    // onReconnectionError is called with an error when maxReconnectionAttempts has been reached
    this.onReconnectionError = reconnectionErrorListener;
  }

  connect() {
    debug(`connecting to ${this.serverUrl}`);

    const websocketConnection = this.configExtraRooms().then(() => new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.serverUrl, "janus-protocol");

      this.session = new mj.JanusSession(this.ws.send.bind(this.ws), { timeoutMs: 30000 });

      let onOpen;

      const onError = () => {
        reject(error);
      };

      this.ws.addEventListener("close", this.onWebsocketClose);
      this.ws.addEventListener("message", this.onWebsocketMessage);

      onOpen = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
        this.onWebsocketOpen()
          .then(resolve)
          .catch(reject);
      };

      this.ws.addEventListener("open", onOpen);
    }));

    return Promise.all([websocketConnection, this.updateTimeOffset()]);
  }

  disconnect() {
    debug(`disconnecting`);

    clearTimeout(this.reconnectionTimeout);

    this.removeAllOccupants();

    if (this.publisher) {
      // Close the publisher peer connection. Which also detaches the plugin handle.
      this.publisher.conn.close();
      dispose(this.publisher);
      this.publisher = null;
    }

    if (this.session) {
      this.session.dispose();
      this.session = null;
    }

    if (this.ws) {
      this.ws.removeEventListener("open", this.onWebsocketOpen);
      this.ws.removeEventListener("close", this.onWebsocketClose);
      this.ws.removeEventListener("message", this.onWebsocketMessage);
      this.ws.close();
      this.ws = null;
    }
  }

  isDisconnected() {
    return this.ws === null;
  }

  async onWebsocketOpen() {
    // Create the Janus Session
    await this.session.create();

    // Attach the SFU Plugin and create a RTCPeerConnection for the publisher.
    // The publisher sends audio and opens two bidirectional data channels.
    // One reliable datachannel and one unreliable.
    this.publisher = await this.createPublisher();

    // Call the naf connectSuccess callback before we start receiving WebRTC messages.
    this.connectSuccess(this.clientId);

    for (let i = 0; i < this.publisher.initialOccupants.length; i++) {
      const occupantId = this.publisher.initialOccupants[i];
      if (occupantId === this.clientId) continue; // Happens during non-graceful reconnects due to zombie sessions
      this.addAvailableOccupant(occupantId);
    }

    this.syncOccupants();
  }

  onWebsocketClose(event) {
    // The connection was closed successfully. Don't try to reconnect.
    if (event.code === WS_NORMAL_CLOSURE) {
      return;
    }

    if (this.onReconnecting) {
      this.onReconnecting(this.reconnectionDelay);
    }

    this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
  }

  reconnect() {
    // Dispose of all networked entities and other resources tied to the session.
    this.disconnect();

    this.connect()
      .then(() => {
        this.reconnectionDelay = this.initialReconnectionDelay;
        this.reconnectionAttempts = 0;

        if (this.onReconnected) {
          this.onReconnected();
        }
      })
      .catch(error => {
        this.reconnectionDelay += 1000;
        this.reconnectionAttempts++;

        if (this.reconnectionAttempts > this.maxReconnectionAttempts && this.onReconnectionError) {
          return this.onReconnectionError(
            new Error("Connection could not be reestablished, exceeded maximum number of reconnection attempts.")
          );
        }

        console.warn("Error during reconnect, retrying.");
        console.warn(error);

        if (this.onReconnecting) {
          this.onReconnecting(this.reconnectionDelay);
        }

        this.reconnectionTimeout = setTimeout(() => this.reconnect(), this.reconnectionDelay);
      });
  }

  performDelayedReconnect() {
    if (this.delayedReconnectTimeout) {
      clearTimeout(this.delayedReconnectTimeout);
    }

    this.delayedReconnectTimeout = setTimeout(() => {
      this.delayedReconnectTimeout = null;
      this.reconnect();
    }, 10000);
  }

  onWebsocketMessage(event) {
    this.session.receive(JSON.parse(event.data));
  }

  addAvailableOccupant(occupantId) {
    if (this.availableOccupants.indexOf(occupantId) === -1) {
      this.availableOccupants.push(occupantId);
    }
  }

  removeAvailableOccupant(occupantId) {
    const idx = this.availableOccupants.indexOf(occupantId);
    if (idx !== -1) {
      this.availableOccupants.splice(idx, 1);
    }
  }

  syncOccupants(requestedOccupants) {
    if (requestedOccupants) {
      this.requestedOccupants = requestedOccupants;
    }
    const checkUpstream = NAF._stream_jmr_downstream;
    let upstreamOccupants = new Set;
    if (checkUpstream) {
      upstreamOccupants = new Set(Object.values(NAF._sess).filter(k=>k));
      upstreamOccupants.forEach(o => this.addAvailableOccupant(o));
    }
    const occupants = new Set(this.requestedOccupants || [])
    upstreamOccupants.forEach(o => occupants.add(o));

    // Add any requested, available, and non-pending occupants.
    occupants.forEach(occupantId => {
      if (!this.occupants[occupantId] && this.availableOccupants.indexOf(occupantId) !== -1 && !this.pendingOccupants.has(occupantId)) {
        if ((checkUpstream) && upstreamOccupants.has(occupantId)) this.addUpstreamOccupant(occupantId)
        else this.addOccupant(occupantId);
      }
    })

    // Remove any unrequested and currently added occupants.
    for (let j = 0; j < this.availableOccupants.length; j++) {
      const occupantId = this.availableOccupants[j];
      if (this.occupants[occupantId] && !occupants.has(occupantId)) {
        this.removeOccupant(occupantId);
      }
    }

    // Call the Networked AFrame callbacks for the updated occupants list.
    this.onOccupantsChanged(this.occupants);
  }

  async addOccupant(occupantId) {
    console.log("subscribing to " + occupantId);
    this.pendingOccupants.add(occupantId);
    
    const availableOccupantsCount = this.availableOccupants.length;
    if (availableOccupantsCount > AVAILABLE_OCCUPANTS_THRESHOLD) {
      await randomDelay(0, MAX_SUBSCRIBE_DELAY);
    }
  
    const subscriber = await this.createSubscriber(occupantId);
    if (subscriber) {
      if(!this.pendingOccupants.has(occupantId)) {
        dispose(subscriber);
      } else {
        this.pendingOccupants.delete(occupantId);
        this.occupantIds.push(occupantId);
        this.occupants[occupantId] = subscriber;

        this.setMediaStream(occupantId, subscriber.mediaStream);

        // Call the Networked AFrame callbacks for the new occupant.
        this.onOccupantConnected(occupantId);
      }
    } else this.pendingOccupants.delete(occupantId);
  }

  removeAllOccupants() {
    this.pendingOccupants.clear();
    for (let i = this.occupantIds.length - 1; i >= 0; i--) {
      this.removeOccupant(this.occupantIds[i]);
    }
  }

  removeOccupant(occupantId) {
    this.pendingOccupants.delete(occupantId);
    
    if (this.occupants[occupantId]) {
      // Close the subscriber peer connection. Which also detaches the plugin handle.
      // this.occupants[occupantId].conn.close();
      dispose(this.occupants[occupantId])
      delete this.occupants[occupantId];
      
      this.occupantIds.splice(this.occupantIds.indexOf(occupantId), 1);
    }

    if (this.mediaStreams[occupantId]) {
      delete this.mediaStreams[occupantId];
    }

    if (this.pendingMediaRequests.has(occupantId)) {
      const msg = "The user disconnected before the media stream was resolved.";
      this.pendingMediaRequests.get(occupantId).audio.reject(msg);
      this.pendingMediaRequests.get(occupantId).video.reject(msg);
      this.pendingMediaRequests.delete(occupantId);
    }

    // Call the Networked AFrame callbacks for the removed occupant.
    this.onOccupantDisconnected(occupantId);
  }

  associate(state) {
    state.conn.addEventListener("icecandidate", ev => {
      state.handle.sendTrickle(ev.candidate || null).catch(e => error("Error trickling ICE: %o", e));
    });
    state.conn.addEventListener("iceconnectionstatechange", ev => {
      if (state.conn.iceConnectionState === "failed") {
        console.warn("ICE failure detected. Reconnecting in 10s.");
        this.performDelayedReconnect();
      }
    })

    // we have to debounce these because janus gets angry if you send it a new SDP before
    // it's finished processing an existing SDP. in actuality, it seems like this is maybe
    // too liberal and we need to wait some amount of time after an offer before sending another,
    // but we don't currently know any good way of detecting exactly how long :(
    state.conn.addEventListener(
      "negotiationneeded",
      debounce(ev => {
        debug("Sending new offer for handle: %o", state.handle);
        var offer = state.conn.createOffer().then(this.configurePublisherSdp).then(this.fixSafariIceUFrag);
        var local = offer.then(o => state.conn.setLocalDescription(o));
        var remote = offer;

        remote = remote
          .then(this.fixSafariIceUFrag)
          .then(j => state.handle.sendJsep(j))
          .then(r => state.conn.setRemoteDescription(r.jsep));
        return Promise.all([local, remote]).catch(e => error("Error negotiating offer: %o", e));
      })
    );
    state.handle.on(
      "event",
      debounce(ev => {
        var jsep = ev.jsep;
        if (jsep && jsep.type == "offer") {
          debug("Accepting new offer for handle: %o", state.handle);
          var answer = state.conn
            .setRemoteDescription(this.configureSubscriberSdp(jsep))
            .then(_ => state.conn.createAnswer())
            .then(this.fixSafariIceUFrag);
          var local = answer.then(a => state.conn.setLocalDescription(a));
          var remote = answer.then(j => state.handle.sendJsep(j));
          return Promise.all([local, remote]).catch(e => error("Error negotiating answer: %o", e));
        } else {
          // some other kind of event, nothing to do
          return null;
        }
      })
    );
  }

  async createPublisher() {
    const state = {
      handle: new mj.JanusPluginHandle(this.session),
      conn: new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG)
    };

    debug("pub waiting for sfu");
    await state.handle.attach("janus.plugin.sfu");

    this.associate(state);

    debug("pub waiting for data channels & webrtcup");
    var webrtcup = new Promise(resolve => state.handle.on("webrtcup", resolve));

    // Unreliable datachannel: sending and receiving component updates.
    // Reliable datachannel: sending and recieving entity instantiations.
    var reliableChannel = state.conn.createDataChannel("reliable", { ordered: true });
    var unreliableChannel = state.conn.createDataChannel("unreliable", {
      ordered: false,
      maxRetransmits: 0
    });

    reliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-reliable"));
    unreliableChannel.addEventListener("message", e => this.onDataChannelMessage(e, "janus-unreliable"));

    await webrtcup;
    await untilDataChannelOpen(reliableChannel);
    await untilDataChannelOpen(unreliableChannel);

    // doing this here is sort of a hack around chrome renegotiation weirdness --
    // if we do it prior to webrtcup, chrome on gear VR will sometimes put a
    // renegotiation offer in flight while the first offer was still being
    // processed by janus. we should find some more principled way to figure out
    // when janus is done in the future.
    if (this.localMediaStream) {
      this.localMediaStream.getTracks().forEach(track => {
        state.conn.addTrack(track, this.localMediaStream);
      });
    }

    // Handle all of the join and leave events.
    state.handle.on("event", ev => {
      var data = ev.plugindata.data;
      if (data.event == "join" && data.room_id == this.room) {
        this.addAvailableOccupant(data.user_id);
        this.syncOccupants();
      } else if (data.event == "leave" && data.room_id == this.room) {
        this.removeAvailableOccupant(data.user_id);
        this.removeOccupant(data.user_id);
      } else if (data.event == "blocked") {
        document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: data.by } }));
      } else if (data.event == "unblocked") {
        document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: data.by } }));
      } else if (data.event === "data") {
        this.onData(JSON.parse(data.body), "janus-event");
      }
    });

    debug("pub waiting for join");

    // Send join message to janus. Listen for join/leave messages. Automatically subscribe to all users' WebRTC data.
    var message = await this.sendJoin(state.handle, {
      notifications: true,
      data: true
    });

    if (!message.plugindata.data.success) {
      const err = message.plugindata.data.error;
      console.error(err);
      throw err;
    }

    var initialOccupants = message.plugindata.data.response.users[this.room] || [];

    if (initialOccupants.includes(this.clientId)) {
      console.warn("Janus still has previous session for this client. Reconnecting in 10s.");
      this.performDelayedReconnect();
    }

    debug("publisher ready");
    return {
      handle: state.handle,
      initialOccupants,
      reliableChannel,
      unreliableChannel,
      conn: state.conn
    };
  }

  configurePublisherSdp(jsep) {
    jsep.sdp = jsep.sdp.replace(/a=fmtp:(109|111).*\r\n/g, (line, pt) => {
      const parameters = Object.assign(sdpUtils.parseFmtp(line), OPUS_PARAMETERS);
      return sdpUtils.writeFmtp({ payloadType: pt, parameters: parameters });
    });
    return jsep;
  }

  configureSubscriberSdp(jsep) {
    // todo: consider cleaning up these hacks to use sdputils
    if (!isH264VideoSupported) {
      if (navigator.userAgent.indexOf("HeadlessChrome") !== -1) {
        // HeadlessChrome (e.g. puppeteer) doesn't support webrtc video streams, so we remove those lines from the SDP.
        jsep.sdp = jsep.sdp.replace(/m=video[^]*m=/, "m=");
      }
    }

    // TODO: Hack to get video working on Chrome for Android. https://groups.google.com/forum/#!topic/mozilla.dev.media/Ye29vuMTpo8
    if (navigator.userAgent.indexOf("Android") === -1) {
      jsep.sdp = jsep.sdp.replace(
        "a=rtcp-fb:107 goog-remb\r\n",
        "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n"
      );
    } else {
      jsep.sdp = jsep.sdp.replace(
        "a=rtcp-fb:107 goog-remb\r\n",
        "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n"
      );
    }
    return jsep;
  }

  async fixSafariIceUFrag(jsep) {
    // Safari produces a \n instead of an \r\n for the ice-ufrag. See https://github.com/meetecho/janus-gateway/issues/1818
    jsep.sdp = jsep.sdp.replace(/[^\r]\na=ice-ufrag/g, "\r\na=ice-ufrag");
    return jsep
  }

  async createSubscriber(occupantId, maxRetries = 5) {
    if (this.availableOccupants.indexOf(occupantId) === -1) {
      console.warn(occupantId + ": cancelled occupant connection, occupant left before subscription negotation.");
      return null;
    }

    const state = {
      handle: new mj.JanusPluginHandle(this.session),
      conn: new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG)
    };

    debug(occupantId + ": sub waiting for sfu");
    await state.handle.attach("janus.plugin.sfu");

    this.associate(state);

    debug(occupantId + ": sub waiting for join");

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancelled occupant connection, occupant left after attach");
      return null;
    }

    let webrtcFailed = false;

    const webrtcup = new Promise(resolve => {
      const leftInterval = setInterval(() => {
        if (this.availableOccupants.indexOf(occupantId) === -1) {
          clearInterval(leftInterval);
          resolve();
        }
      }, 1000);

      const timeout = setTimeout(() => {
        clearInterval(leftInterval);
        webrtcFailed = true;
        resolve();
      }, SUBSCRIBE_TIMEOUT_MS);

      state.handle.on("webrtcup", () => {
        clearTimeout(timeout);
        clearInterval(leftInterval);
        resolve();
      });
    });

    // Send join message to janus. Don't listen for join/leave messages. Subscribe to the occupant's media.
    // Janus should send us an offer for this occupant's media in response to this.
    await this.sendJoin(state.handle, { media: occupantId });

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancelled occupant connection, occupant left after join");
      return null;
    }

    debug(occupantId + ": sub waiting for webrtcup");
    await webrtcup;

    if (this.availableOccupants.indexOf(occupantId) === -1) {
      dispose(state);
      console.warn(occupantId + ": cancel occupant connection, occupant left during or after webrtcup");
      return null;
    }

    if (webrtcFailed) {
      dispose(state);
      if (maxRetries > 0) {
        console.warn(occupantId + ": webrtc up timed out, retrying");
        return this.createSubscriber(occupantId, maxRetries - 1);
      } else {
        console.warn(occupantId + ": webrtc up timed out");
        return null;
      }
    }

    if (isSafari && !this._iOSHackDelayedInitialPeer) {
      // HACK: the first peer on Safari during page load can fail to work if we don't
      // wait some time before continuing here. See: https://github.com/mozilla/hubs/pull/1692
      await (new Promise((resolve) => setTimeout(resolve, 3000)));
      this._iOSHackDelayedInitialPeer = true;
    }

    var mediaStream = new MediaStream();
    var receivers = state.conn.getReceivers();
    receivers.forEach(receiver => {
      if (receiver.track) {
        mediaStream.addTrack(receiver.track);
      }
    });
    if (mediaStream.getTracks().length === 0) {
      mediaStream = null;
    }

    debug(occupantId + ": subscriber ready");
    state.mediaStream = mediaStream;
    return state;
  }

  sendJoin(handle, subscribe) {
    return handle.sendMessage({
      kind: "join",
      room_id: this.mainRooms.join('-'),
      user_id: this.clientId,
      subscribe,
      token: this.joinToken
    });
  }

  toggleFreeze() {
    if (this.frozen) {
      this.unfreeze();
    } else {
      this.freeze();
    }
  }

  freeze() {
    this.frozen = true;
  }

  unfreeze() {
    this.frozen = false;
    this.flushPendingUpdates();
  }

  dataForUpdateMultiMessage(networkId, message) {
    // "d" is an array of entity datas, where each item in the array represents a unique entity and contains
    // metadata for the entity, and an array of components that have been updated on the entity.
    // This method finds the data corresponding to the given networkId.
    for (let i = 0, l = message.data.d.length; i < l; i++) {
      const data = message.data.d[i];

      if (data.networkId === networkId) {
        return data;
      }
    }

    return null;
  }

  getPendingData(networkId, message) {
    if (!message) return null;

    let data = message.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, message) : message.data;

    // Ignore messages relating to users who have disconnected since freezing, their entities
    // will have aleady been removed by NAF.
    // Note that delete messages have no "owner" so we have to check for that as well.
    if (data.owner && !this.occupants[data.owner]) return null;

    // Ignore messages from users that we may have blocked while frozen.
    if (data.owner && this.blockedClients.has(data.owner)) return null;

    return data
  }

  // Used externally
  getPendingDataForNetworkId(networkId) {
    return this.getPendingData(networkId, this.frozenUpdates.get(networkId));
  }

  flushPendingUpdates() {
    for (const [networkId, message] of this.frozenUpdates) {
      let data = this.getPendingData(networkId, message);
      if (!data) continue;

      // Override the data type on "um" messages types, since we extract entity updates from "um" messages into
      // individual frozenUpdates in storeSingleMessage.
      const dataType = message.dataType === "um" ? "u" : message.dataType;

      this.onOccupantMessage(null, dataType, data, message.source);
    }
    this.frozenUpdates.clear();
  }

  storeMessage(message) {
    if (message.dataType === "um") { // UpdateMulti
      for (let i = 0, l = message.data.d.length; i < l; i++) {
        this.storeSingleMessage(message, i);
      }
    } else {
      this.storeSingleMessage(message);
    }
  }

  storeSingleMessage(message, index) {
    const data = index !== undefined ? message.data.d[index] : message.data;
    const dataType = message.dataType;
    const source = message.source;

    const networkId = data.networkId;

    if (!this.frozenUpdates.has(networkId)) {
      this.frozenUpdates.set(networkId, message);
    } else {
      const storedMessage = this.frozenUpdates.get(networkId);
      const storedData = storedMessage.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, storedMessage) : storedMessage.data;

      // Avoid updating components if the entity data received did not come from the current owner.
      const isOutdatedMessage = data.lastOwnerTime < storedData.lastOwnerTime;
      const isContemporaneousMessage = data.lastOwnerTime === storedData.lastOwnerTime;
      if (isOutdatedMessage || (isContemporaneousMessage && storedData.owner > data.owner)) {
        return;
      }

      if (dataType === "r") {
        const createdWhileFrozen = storedData && storedData.isFirstSync;
        if (createdWhileFrozen) {
          // If the entity was created and deleted while frozen, don't bother conveying anything to the consumer.
          this.frozenUpdates.delete(networkId);
        } else {
          // Delete messages override any other messages for this entity
          this.frozenUpdates.set(networkId, message);
        }
      } else {
        // merge in component updates
        if (storedData.components && data.components) {
          Object.assign(storedData.components, data.components);
        }
      }
    }
  }

  onDataChannelMessage(e, source) {
    this.onData(JSON.parse(e.data), source);
  }

  onData(message, source) {
    if (debug.enabled) {
      debug(`DC in: ${message}`);
    }

    if (!message.dataType) return;

    message.source = source;

    if (this.frozen) {
      this.storeMessage(message);
    } else {
      this.onOccupantMessage(message.from_relay ? 'relay' : null, message.dataType, message.data, message.source);
    }
  }

  shouldStartConnectionTo(client) {
    return true;
  }

  startStreamConnection(client) {}

  closeStreamConnection(client) {}

  getConnectStatus(clientId) {
    return this.occupants[clientId] ? NAF.adapters.IS_CONNECTED : NAF.adapters.NOT_CONNECTED;
  }

  async updateTimeOffset() {
    if (this.isDisconnected()) return;

    const clientSentTime = Date.now();

    const res = await fetch(document.location.href, {
      method: "HEAD",
      cache: "no-cache"
    });

    const precision = 1000;
    const serverReceivedTime = new Date(res.headers.get("Date")).getTime() + precision / 2;
    const clientReceivedTime = Date.now();
    const serverTime = serverReceivedTime + (clientReceivedTime - clientSentTime) / 2;
    const timeOffset = serverTime - clientReceivedTime;

    this.serverTimeRequests++;

    if (this.serverTimeRequests <= 10) {
      this.timeOffsets.push(timeOffset);
    } else {
      this.timeOffsets[this.serverTimeRequests % 10] = timeOffset;
    }

    this.avgTimeOffset = this.timeOffsets.reduce((acc, offset) => (acc += offset), 0) / this.timeOffsets.length;

    if (this.serverTimeRequests > 10) {
      debug(`new server time offset: ${this.avgTimeOffset}ms`);
      setTimeout(() => this.updateTimeOffset(), 5 * 60 * 1000); // Sync clock every 5 minutes.
    } else {
      this.updateTimeOffset();
    }
  }

  getServerTime() {
    return Date.now() + this.avgTimeOffset;
  }

  getMediaStream(clientId, type = "audio") {
    if (this.mediaStreams[clientId]) {
      debug(`Already had ${type} for ${clientId}`);
      return Promise.resolve(this.mediaStreams[clientId][type]);
    } else {
      debug(`Waiting on ${type} for ${clientId}`);
      if (!this.pendingMediaRequests.has(clientId)) {
        this.pendingMediaRequests.set(clientId, {});

        const audioPromise = new Promise((resolve, reject) => {
          this.pendingMediaRequests.get(clientId).audio = { resolve, reject };
        });
        const videoPromise = new Promise((resolve, reject) => {
          this.pendingMediaRequests.get(clientId).video = { resolve, reject };
        });

        this.pendingMediaRequests.get(clientId).audio.promise = audioPromise;
        this.pendingMediaRequests.get(clientId).video.promise = videoPromise;

        audioPromise.catch(e => console.warn(`${clientId} getMediaStream Audio Error`, e));
        videoPromise.catch(e => console.warn(`${clientId} getMediaStream Video Error`, e));
      }
      return this.pendingMediaRequests.get(clientId)[type].promise;
    }
  }

  setMediaStream(clientId, stream) {
    console.log("Got stream of " + clientId);
    // Safari doesn't like it when you use single a mixed media stream where one of the tracks is inactive, so we
    // split the tracks into two streams.
    const audioStream = new MediaStream();
    try {
    stream.getAudioTracks().forEach(track => audioStream.addTrack(track));

    } catch(e) {
      console.warn(`${clientId} setMediaStream Audio Error`, e);
    }
    const videoStream = new MediaStream();
    try {
    stream.getVideoTracks().forEach(track => videoStream.addTrack(track));

    } catch (e) {
      console.warn(`${clientId} setMediaStream Video Error`, e);
    }

    this.mediaStreams[clientId] = { audio: audioStream, video: videoStream };

    // Resolve the promise for the user's media stream if it exists.
    if (this.pendingMediaRequests.has(clientId)) {
      this.pendingMediaRequests.get(clientId).audio.resolve(audioStream);
      this.pendingMediaRequests.get(clientId).video.resolve(videoStream);
    }
  }

  async setLocalMediaStream(stream) {
    // our job here is to make sure the connection winds up with RTP senders sending the stuff in this stream,
    // and not the stuff that isn't in this stream. strategy is to replace existing tracks if we can, add tracks
    // that we can't replace, and disable tracks that don't exist anymore.

    // note that we don't ever remove a track from the stream -- since Janus doesn't support Unified Plan, we absolutely
    // can't wind up with a SDP that has >1 audio or >1 video tracks, even if one of them is inactive (what you get if
    // you remove a track from an existing stream.)
    if (this.publisher && this.publisher.conn) {
      const existingSenders = this.publisher.conn.getSenders();
      const newSenders = [];
      const tracks = stream.getTracks();

      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const sender = existingSenders.find(s => s.track != null && s.track.kind == t.kind);

        if (sender != null) {
          if (sender.replaceTrack) {
            await sender.replaceTrack(t);

            // Workaround https://bugzilla.mozilla.org/show_bug.cgi?id=1576771
            if (t.kind === "video" && t.enabled && navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
              t.enabled = false;
              setTimeout(() => t.enabled = true, 1000);
            }
          } else {
            // Fallback for browsers that don't support replaceTrack. At this time of this writing
            // most browsers support it, and testing this code path seems to not work properly
            // in Chrome anymore.
            stream.removeTrack(sender.track);
            stream.addTrack(t);
          }
          newSenders.push(sender);
        } else {
          newSenders.push(this.publisher.conn.addTrack(t, stream));
        }
      }
      existingSenders.forEach(s => {
        if (!newSenders.includes(s)) {
          s.track.enabled = false;
        }
      });
    }
    this.localMediaStream = stream;
    this.setMediaStream(this.clientId, stream);
    Object.values(this._sessions).forEach(sess => sess.setLocalMediaStream(stream))
  }

  enableMicrophone(enabled) {
    if (this.publisher && this.publisher.conn) {
      this.publisher.conn.getSenders().forEach(s => {
        if (s.track.kind == "audio") {
          s.track.enabled = enabled;
        }
      });
    }
    Object.values(this._publishers).forEach(pub => {
      if (pub.conn) {
        pub.conn.getSenders().forEach(s => {
          if (s.track.kind == "audio") {
            s.track.enabled = enabled;
          }
        });
      }
    })
  }

  sendData(clientId, dataType, data) {
    if (!this.publisher) {
      console.warn("sendData called without a publisher");
    } else {
      switch (this.unreliableTransport) {
        case "websocket":
          this.publisher.handle.sendMessage({ kind: "data", body: JSON.stringify({ dataType, data }), whom: clientId });
          break;
        case "datachannel":
          this.publisher.unreliableChannel.send(JSON.stringify({ clientId, dataType, data }));
          break;
        default:
          this.unreliableTransport(clientId, dataType, data);
          break;
      }
    }
  }

  sendDataGuaranteed(clientId, dataType, data) {
    if (!this.publisher) {
      console.warn("sendDataGuaranteed called without a publisher");
    } else {
      switch (this.reliableTransport) {
        case "websocket":
          this.publisher.handle.sendMessage({ kind: "data", body: JSON.stringify({ dataType, data }), whom: clientId });
          break;
        case "datachannel":
          this.publisher.reliableChannel.send(JSON.stringify({ clientId, dataType, data }));
          break;
        default:
          this.reliableTransport(clientId, dataType, data);
          break;
      }
    }
  }

  broadcastData(dataType, data) {
    if (!this.publisher) {
      console.warn("broadcastData called without a publisher");
    } else {
      switch (this.unreliableTransport) {
        case "websocket":
          this.publisher.handle.sendMessage({ kind: "data", body: JSON.stringify({ dataType, data }) });
          break;
        case "datachannel":
          this.publisher.unreliableChannel.send(JSON.stringify({ dataType, data }));
          break;
        default:
          this.unreliableTransport(undefined, dataType, data);
          break;
      }
    }
  }

  broadcastDataGuaranteed(dataType, data) {
    if (!this.publisher) {
      console.warn("broadcastDataGuaranteed called without a publisher");
    } else {
      switch (this.reliableTransport) {
        case "websocket":
          this.publisher.handle.sendMessage({ kind: "data", body: JSON.stringify({ dataType, data }) });
          break;
        case "datachannel":
          this.publisher.reliableChannel.send(JSON.stringify({ dataType, data }));
          break;
        default:
          this.reliableTransport(undefined, dataType, data);
          break;
      }
    }
  }

  kick(clientId, permsToken) {
    return this.publisher.handle.sendMessage({ kind: "kick", room_id: this.room, user_id: clientId, token: permsToken }).then(() => {
      document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
    });
  }

  block(clientId) {
    return this.publisher.handle.sendMessage({ kind: "block", whom: clientId }).then(() => {
      this.blockedClients.set(clientId, true);
      document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
    });
  }

  unblock(clientId) {
    return this.publisher.handle.sendMessage({ kind: "unblock", whom: clientId }).then(() => {
      this.blockedClients.delete(clientId);
      document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
    });
  }
}

NAF.adapters.register("janus", JanusAdapter);

module.exports = JanusAdapter;
