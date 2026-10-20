// Voynix Echo skill: "アレクサ、<呼び出し名>、ドライブをかけて" plays that Voynix
// playlist on the Echo.
//
// The skill never contacts the Mac. It signs a URL (playback.js) that the Echo
// then fetches from the Mac on the LAN, and queues the next track's URL when the
// current one is nearly over. The Mac matches the spoken playlist name, shuffles
// from the seed and picks track `i`; see docs/echo-lan.md.
//
// Everything interesting is written to the log (CloudWatch / the console's
// "Logs" tab): PLAY, SESSION ENDED and especially AudioPlayer.PlaybackFailed.
const Alexa = require('ask-sdk-core');
const config = require('./config.json');
const { playUrl, makeToken, parseToken, newSeed, playlistFromSlot } = require('./playback');

const isSpoken = (h) => ['LaunchRequest', 'IntentRequest'].includes(Alexa.getRequestType(h.requestEnvelope));

const isIntent = (...names) => (h) =>
  Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
  names.includes(Alexa.getIntentName(h.requestEnvelope));

/** Starts (or restarts) playback of track `i`. `speech` is said first, if given. */
function play(h, { list, i, seed }, { behavior = 'REPLACE_ALL', speech, expectedPreviousToken, offsetMs = 0 } = {}) {
  const url = playUrl(config, list, i, seed);
  console.log(`PLAY ${behavior} i=${i} seed=${seed} list=${list}`);
  const builder = h.responseBuilder;
  if (speech) builder.speak(speech);
  builder.addAudioPlayerPlayDirective(behavior, url, makeToken(list, i, seed), offsetMs, expectedPreviousToken);
  // Alexa only accepts shouldEndSession in replies to what the user said; replies to
  // AudioPlayer.* and PlaybackController.* events are directives only.
  if (isSpoken(h)) builder.withShouldEndSession(true);
  return builder.getResponse();
}

const ASK_PLAYLIST = 'どのプレイリストをかけますか？';

const LaunchHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest',
  handle: (h) => h.responseBuilder.speak(ASK_PLAYLIST).reprompt(ASK_PLAYLIST).getResponse(),
};

const HelpHandler = {
  canHandle: isIntent('AMAZON.HelpIntent'),
  handle: (h) =>
    h.responseBuilder
      .speak('プレイリストの名前に続けて、をかけて、と言ってください。シャッフルして、でも再生できます。')
      .reprompt(ASK_PLAYLIST)
      .getResponse(),
};

const makePlayPlaylistHandler = (intentName, shuffle) => ({
  canHandle: isIntent(intentName),
  handle: (h) => {
    const list = playlistFromSlot(Alexa.getSlot(h.requestEnvelope, 'playlist'));
    if (!list) return h.responseBuilder.speak(ASK_PLAYLIST).reprompt(ASK_PLAYLIST).getResponse();
    return play(h, { list, i: 0, seed: shuffle ? newSeed() : 0 }, {
      speech: `${list}を${shuffle ? 'シャッフルして' : ''}かけます`,
    });
  },
});

// The AudioPlayer context says what is playing right now (and how far in).
function nowPlaying(h) {
  const audio = h.requestEnvelope.context?.AudioPlayer;
  const state = parseToken(audio?.token);
  return state ? { state, offsetMs: audio.offsetInMilliseconds ?? 0 } : null;
}

const StopHandler = {
  canHandle: isIntent('AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.PauseIntent'),
  handle: (h) => h.responseBuilder.addAudioPlayerStopDirective().getResponse(),
};

function resume(h) {
  const current = nowPlaying(h);
  if (!current) return askPlaylist(h);
  // The old URL may have expired while paused, so sign a fresh one for the same track.
  return play(h, current.state, { offsetMs: current.offsetMs });
}

function skip(h, by) {
  const current = nowPlaying(h);
  if (!current) return askPlaylist(h);
  return play(h, { ...current.state, i: Math.max(0, current.state.i + by) });
}

// Without anything playing there is nothing to resume or skip: ask, by voice.
// (Only for spoken requests; PlaybackController events must not get speech.)
function askPlaylist(h) {
  if (!isSpoken(h)) return h.responseBuilder.getResponse();
  return h.responseBuilder.speak(ASK_PLAYLIST).reprompt(ASK_PLAYLIST).getResponse();
}

const ResumeHandler = { canHandle: isIntent('AMAZON.ResumeIntent'), handle: resume };
const NextHandler = { canHandle: isIntent('AMAZON.NextIntent'), handle: (h) => skip(h, 1) };
const PreviousHandler = { canHandle: isIntent('AMAZON.PreviousIntent'), handle: (h) => skip(h, -1) };

// The same actions from a device button, the Alexa app or an Echo Show's screen.
const isController = (type) => (h) => Alexa.getRequestType(h.requestEnvelope) === `PlaybackController.${type}`;
const ControllerHandlers = [
  { canHandle: isController('PlayCommandIssued'), handle: resume },
  { canHandle: isController('PauseCommandIssued'), handle: (h) => h.responseBuilder.addAudioPlayerStopDirective().getResponse() },
  { canHandle: isController('NextCommandIssued'), handle: (h) => skip(h, 1) },
  { canHandle: isController('PreviousCommandIssued'), handle: (h) => skip(h, -1) },
];

// Queue the following track a little before the current one ends so playback
// continues without a gap. Past the last track the Mac answers 404; the Echo
// then reports PlaybackFailed for the queued item and stops, which is fine.
const NearlyFinishedHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished',
  handle: (h) => {
    const token = h.requestEnvelope.request.token;
    const state = parseToken(token);
    console.log(`AudioPlayer.PlaybackNearlyFinished token=${token}`);
    if (!state) return h.responseBuilder.getResponse();
    return play(h, { ...state, i: state.i + 1 }, { behavior: 'ENQUEUE', expectedPreviousToken: token });
  },
};

// The rest of the AudioPlayer.* events are only logged. PlaybackFailed carries the reason.
const AudioPlayerEventHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope).startsWith('AudioPlayer.'),
  handle: (h) => {
    const req = h.requestEnvelope.request;
    console.log(`${req.type} offsetMs=${req.offsetInMilliseconds ?? '-'} token=${req.token ?? '-'}`);
    if (req.type === 'AudioPlayer.PlaybackFailed') {
      console.log('PLAYBACK FAILED', JSON.stringify({ error: req.error, state: req.currentPlaybackState }));
    }
    return h.responseBuilder.getResponse();
  },
};

const SessionEndedHandler = {
  canHandle: (h) => Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
  handle: (h) => {
    const req = h.requestEnvelope.request;
    console.log('SESSION ENDED', JSON.stringify({ reason: req.reason, error: req.error }));
    return h.responseBuilder.getResponse();
  },
};

const FallbackHandler = {
  canHandle: isSpoken,
  handle: (h) => h.responseBuilder.speak(`すみません、わかりませんでした。${ASK_PLAYLIST}`).reprompt(ASK_PLAYLIST).getResponse(),
};

// One line per request: what Alexa understood (intent and slot values).
const LogRequestInterceptor = {
  process(h) {
    const req = h.requestEnvelope.request;
    const slots = Object.fromEntries(
      Object.entries(req.intent?.slots ?? {}).map(([name, slot]) => [name, slot.value ?? null])
    );
    console.log(`REQUEST ${req.type} ${req.intent?.name ?? '-'} ${JSON.stringify(slots)}`);
  },
};

// Whatever else arrives (System.ExceptionEncountered, events we don't act on) gets an
// empty reply: speech there would be an invalid response.
const IgnoreHandler = {
  canHandle: () => true,
  handle: (h) => {
    const req = h.requestEnvelope.request;
    if (req.type === 'System.ExceptionEncountered') console.log('EXCEPTION', JSON.stringify(req.error), JSON.stringify(req.cause));
    return h.responseBuilder.getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestInterceptors(LogRequestInterceptor)
  .addRequestHandlers(
    LaunchHandler,
    HelpHandler,
    makePlayPlaylistHandler('PlayPlaylistIntent', false),
    makePlayPlaylistHandler('ShufflePlaylistIntent', true),
    StopHandler,
    ResumeHandler,
    NextHandler,
    PreviousHandler,
    ...ControllerHandlers,
    NearlyFinishedHandler,
    AudioPlayerEventHandler,
    SessionEndedHandler,
    FallbackHandler,
    IgnoreHandler
  )
  .addErrorHandlers({
    canHandle: () => true,
    handle: (h, e) => {
      console.error('ERROR', e);
      return h.responseBuilder.speak('エラーが起きました').getResponse();
    },
  })
  .lambda();
