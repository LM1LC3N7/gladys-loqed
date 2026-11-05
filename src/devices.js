// -----------------------------------------------------------------------------
// The LOQED lock -> one Gladys device (pure).
//
// External ids: `gladys.externalIds('bridge', '<mac>')`, the MAC address
// (Wi-Fi) the bridge gives in /status, 12 lower-case hex digits (Home
// Assistant keys the lock on the same value). One bridge drives one lock.
// Feature keys are frozen:
//
//   state         lock / state, read only: 1 locked (night lock), 0 unlocked
//                 (day lock or latch pulled), 2 moving, 3 jammed
//   position      text, read only: the position in words
//   battery       battery / integer %, read only (never while the lock is away)
//   lock          button / push: lock (night lock), always allowed
//   unlock        button / push: unlock (day lock), refused unless allowed
//   open          button / push: pull the latch (opens the door), refused
//                 unless both options allow it
//   last_command  text, read only: the last command and how it ended
//
// A lock is never a `switch` nor a commandable `binary`: a "turn everything
// off/on" (voice assistants, HomeKit, scenes on switches) must never reach it.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, FEATURES, POSITIONS } from './constants.js';
import { FEATURE_NAMES, POSITION_TEXT, word } from './i18n.js';
import { normalizeMac } from './loqed.js';

/** LOCK.STATE values of the Gladys core. */
export const LOCK_STATE = { UNLOCKED: 0, LOCKED: 1, ACTIVITY: 2, ERROR: 3 };

export const deviceIds = (gladys, mac) => gladys.externalIds(EXTERNAL_ID_TYPE, mac);

const KEYS = new Set(Object.values(FEATURES));

/** `{ mac, key? }` of one of our external ids, checked against the ids the SDK builds. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const feature = /:([0-9a-f]{12}):([a-z_]{1,20})$/.exec(externalId);
  if (
    feature &&
    KEYS.has(feature[2]) &&
    deviceIds(gladys, feature[1]).feature(feature[2]) === externalId
  ) {
    return { mac: feature[1], key: feature[2] };
  }
  const device = /:([0-9a-f]{12})$/.exec(externalId);
  if (device && normalizeMac(device[1]) && deviceIds(gladys, device[1]).device === externalId) {
    return { mac: device[1] };
  }
  return undefined;
}

const sensor = (category, type, min, max, unit) => ({
  category,
  type,
  min,
  max,
  ...(unit ? { unit } : {}),
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});
const text = () => ({
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/** The features of the lock, in a stable order. */
export const FEATURE_SPECS = [
  { key: FEATURES.STATE, spec: sensor(C.LOCK, T.LOCK.STATE, 0, 3), name: FEATURE_NAMES.state },
  { key: FEATURES.POSITION, spec: text(), name: FEATURE_NAMES.position },
  {
    key: FEATURES.BATTERY,
    spec: sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, U.PERCENT),
    name: FEATURE_NAMES.battery,
  },
  { key: FEATURES.LOCK, spec: button(), name: FEATURE_NAMES.lock },
  { key: FEATURES.UNLOCK, spec: button(), name: FEATURE_NAMES.unlock },
  { key: FEATURES.OPEN, spec: button(), name: FEATURE_NAMES.open },
  { key: FEATURES.LAST_COMMAND, spec: text(), name: FEATURE_NAMES.lastCommand },
];

export const deviceName = (mac) => `LOQED ${mac.slice(-6).toUpperCase()}`;

/** The Gladys device of the lock behind bridge `mac`. */
export function buildDevice(gladys, mac, { language, host }) {
  const ids = deviceIds(gladys, mac);
  return {
    name: deviceName(mac),
    external_id: ids.device,
    features: FEATURE_SPECS.map(({ key, spec, name }) => ({
      name: word(name, language).slice(0, 100),
      external_id: ids.feature(key),
      ...spec,
    })),
    params: [
      { name: 'BRIDGE_MAC', value: mac },
      ...(host ? [{ name: 'BRIDGE_ADDRESS', value: host }] : []),
    ],
    should_poll: false,
  };
}

/** The LOCK.STATE value of a position; undefined for an unknown one. */
export function lockStateOf(position) {
  switch (position) {
    case POSITIONS.LOCKED:
      return LOCK_STATE.LOCKED;
    case POSITIONS.UNLOCKED:
    case POSITIONS.OPEN:
      return LOCK_STATE.UNLOCKED;
    case POSITIONS.MOVING:
      return LOCK_STATE.ACTIVITY;
    case POSITIONS.JAMMED:
      return LOCK_STATE.ERROR;
    default:
      return undefined;
  }
}

/** `[{ key, value }]` of a known position: the state and its words. */
export function positionValues(position, language) {
  const state = lockStateOf(position);
  if (state === undefined) {
    return [];
  }
  return [
    { key: FEATURES.STATE, value: state },
    { key: FEATURES.POSITION, value: { text: word(POSITION_TEXT[position], language) } },
  ];
}
