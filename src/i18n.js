// -----------------------------------------------------------------------------
// User-facing texts, English and French: feature names, the connection status
// of the Configuration screen, the answers of the commands and of the
// actions. Never a key, a token or a signed command in any of them.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

export const FEATURE_NAMES = {
  state: { en: 'Lock state', fr: 'État de la serrure' },
  position: { en: 'Position', fr: 'Position' },
  battery: { en: 'Battery', fr: 'Batterie' },
  lock: { en: 'Lock', fr: 'Verrouiller' },
  unlock: { en: 'Unlock', fr: 'Déverrouiller' },
  open: { en: 'Open the door', fr: 'Ouvrir la porte' },
  lastCommand: { en: 'Last command', fr: 'Dernière commande' },
};

export const POSITION_TEXT = {
  locked: { en: 'Locked (night lock)', fr: 'Verrouillée (nuit)' },
  unlocked: { en: 'Unlocked (day lock)', fr: 'Déverrouillée (jour)' },
  open: { en: 'Open (latch pulled)', fr: 'Ouverte (pêne tiré)' },
  moving: { en: 'Moving', fr: 'En mouvement' },
  jammed: { en: 'Jammed (motor stall)', fr: 'Bloquée (moteur)' },
};

/** Connection status texts (Configuration screen). */
export const T = {
  connecting: { en: 'Connecting to the bridge…', fr: 'Connexion au pont…' },
  connected: { en: 'Connected to the bridge', fr: 'Connecté au pont' },
  noAddress: {
    en: 'Enter the IP address of the LOQED bridge.',
    fr: 'Saisissez l’adresse IP du pont LOQED.',
  },
  badAddress: {
    en: 'The bridge address must be an IP address (with an optional port), not a name.',
    fr: 'L’adresse du pont doit être une adresse IP (avec un port facultatif), pas un nom.',
  },
  badKeyId: {
    en: 'The key id must be a whole number from 0 to 255: commands are off.',
    fr: 'Le numéro de clé doit être un entier de 0 à 255 : commandes désactivées.',
  },
  noLocalKey: {
    en: 'No local key: the lock is read, commands are off.',
    fr: 'Pas de clé locale : la serrure est lue, commandes désactivées.',
  },
  badLocalKey: {
    en: 'The local key is not valid base64: commands are off.',
    fr: 'La clé locale n’est pas du base64 valide : commandes désactivées.',
  },
  noBridgeKey: {
    en: 'No bridge key: no webhook, the bridge is only read.',
    fr: 'Pas de clé du pont : pas de webhook, le pont est seulement lu.',
  },
  badBridgeKey: {
    en: 'The bridge key is not valid base64: no webhook, the bridge is only read.',
    fr: 'La clé du pont n’est pas du base64 valide : pas de webhook, le pont est seulement lu.',
  },
  noCallback: {
    en: 'No Gladys address: no webhook, the bridge is only read.',
    fr: 'Pas d’adresse de Gladys : pas de webhook, le pont est seulement lu.',
  },
  badCallback: {
    en: 'The Gladys address must be an IP address: no webhook, the bridge is only read.',
    fr: 'L’adresse de Gladys doit être une adresse IP : pas de webhook, le pont est seulement lu.',
  },
  unreachable: {
    en: 'The bridge does not answer.',
    fr: 'Le pont ne répond pas.',
  },
  badAnswer: {
    en: 'Something answers at this address, but not a LOQED bridge.',
    fr: 'Quelque chose répond à cette adresse, mais pas un pont LOQED.',
  },
  paused: {
    en: 'The bridge asked to wait: reads paused (locking still goes).',
    fr: 'Le pont a demandé d’attendre : lectures en pause (le verrouillage part quand même).',
  },
  otherBridge: {
    en: 'Another bridge answers at this address: it is not read. Check the address, or press "Use the bridge now answering".',
    fr: 'Un autre pont répond à cette adresse : il n’est pas lu. Vérifiez l’adresse, ou utilisez « Utiliser le pont qui répond maintenant ».',
  },
  dataUnreadable: {
    en: '/data/loqed.json cannot be read: unlocking and opening are refused, nothing is written.',
    fr: '/data/loqed.json est illisible : déverrouillage et ouverture refusés, rien n’est écrit.',
  },
  keyRefused: {
    en: 'The bridge refused the local key: no command is sent by itself. Save the right key, or press "Test the connection".',
    fr: 'Le pont a refusé la clé locale : aucune commande ne part d’elle-même. Enregistrez la bonne clé, ou utilisez « Tester la connexion ».',
  },
  lockOffline: {
    en: 'The lock is not connected to the bridge.',
    fr: 'La serrure n’est pas connectée au pont.',
  },
  lockPending: {
    en: 'A lock was sent and waits for the lock to confirm it.',
    fr: 'Un verrouillage est parti et attend la confirmation de la serrure.',
  },
  lockSending: {
    en: 'A lock is being sent.',
    fr: 'Un verrouillage est en cours d’envoi.',
  },
  lockNotLeft: {
    en: 'A lock waits: it has not left yet (the bridge does not answer); it is tried every 10 s.',
    fr: 'Un verrouillage attend : il n’est pas encore parti (le pont ne répond pas) ; il est réessayé toutes les 10 s.',
  },
  lockNoConfig: {
    en: 'A lock waits: it has not left (no bridge address or no valid key); it leaves once they are saved.',
    fr: 'Un verrouillage attend : il n’est pas parti (pas d’adresse du pont ou pas de clé valide) ; il part dès qu’elles sont enregistrées.',
  },
  lockKeyRefused: {
    en: 'A lock waits: the bridge refused the local key; it leaves with a new key or a successful test.',
    fr: 'Un verrouillage attend : le pont a refusé la clé locale ; il part avec une nouvelle clé ou un test réussi.',
  },
  lockGivenUp: {
    en: 'Lock sent 3 times without the lock reporting it locked: check the lock.',
    fr: 'Verrouillage envoyé 3 fois sans que la serrure se dise verrouillée : vérifiez la serrure.',
  },
  webhooksOn: { en: 'webhooks on', fr: 'webhooks actifs' },
  webhooksOff: { en: 'no webhook', fr: 'pas de webhook' },
  receiverDown: {
    en: 'The webhook receiver is not running: the bridge is only read.',
    fr: 'Le récepteur des webhooks ne tourne pas : le pont est seulement lu.',
  },
  hookRefused: {
    en: 'The bridge refused the bridge key (webhooks): the bridge is only read.',
    fr: 'Le pont a refusé la clé du pont (webhooks) : le pont est seulement lu.',
  },
  hookFailed: {
    en: 'The webhook could not be registered at the bridge: the bridge is only read.',
    fr: 'Le webhook n’a pas pu être inscrit sur le pont : le pont est seulement lu.',
  },
  webhookRefused: {
    en: 'Webhooks refused (bad signature, time or sender).',
    fr: 'Webhooks refusés (signature, heure ou expéditeur).',
  },
  configRetry: {
    en: 'The configuration could not be read from Gladys: trying again.',
    fr: 'La configuration n’a pas pu être lue depuis Gladys : nouvel essai.',
  },
  sensitiveAfterRestart: {
    en: 'An unlock or open may have left just before the restart.',
    fr: 'Un déverrouillage ou une ouverture est peut-être parti juste avant le redémarrage.',
  },
};

/** Answers of the commands (the ack of setValue and the "last command" text). */
export const C = {
  lockSent: {
    en: 'Lock sent; waiting for the lock to confirm.',
    fr: 'Verrouillage envoyé ; en attente de la confirmation de la serrure.',
  },
  lockConfirmed: {
    en: 'Locked (confirmed by the lock).',
    fr: 'Verrouillée (confirmé par la serrure).',
  },
  lockNotSent: {
    en: 'Lock not sent yet (the bridge does not answer): it is kept and sent as soon as the bridge answers.',
    fr: 'Verrouillage pas encore envoyé (le pont ne répond pas) : il est gardé et part dès que le pont répond.',
  },
  lockNoAnswer: {
    en: 'Lock sent, without an answer from the bridge: kept, read again and sent again if needed.',
    fr: 'Verrouillage envoyé, sans réponse du pont : gardé, relu et renvoyé si besoin.',
  },
  lockKeyRefused: {
    en: 'The bridge refused the local key: the lock is kept and sent once a new key is saved or the connection test succeeds.',
    fr: 'Le pont a refusé la clé locale : le verrouillage est gardé et part dès qu’une nouvelle clé est enregistrée ou que le test de connexion réussit.',
  },
  lockError: {
    en: 'The bridge answered an error: the lock is kept and sent again.',
    fr: 'Le pont a répondu une erreur : le verrouillage est gardé et renvoyé.',
  },
  lockNoConfig: {
    en: 'Lock kept: no bridge address or local key yet. It leaves once they are saved.',
    fr: 'Verrouillage gardé : pas encore d’adresse du pont ni de clé locale. Il part dès qu’elles sont enregistrées.',
  },
  lockOverridden: {
    en: 'Lock not sent again: the lock was moved afterwards with another key (app, keypad).',
    fr: 'Verrouillage non renvoyé : la serrure a été manœuvrée ensuite avec une autre clé (app, clavier).',
  },
  unlockOff: {
    en: 'Unlocking from Gladys is off (option "Allow unlocking").',
    fr: 'Le déverrouillage depuis Gladys est désactivé (option « Autoriser le déverrouillage »).',
  },
  openOff: {
    en: 'Opening the door from Gladys is off (options "Allow unlocking" and "Allow opening the door").',
    fr: 'L’ouverture de la porte depuis Gladys est désactivée (options « Autoriser le déverrouillage » et « Autoriser l’ouverture de la porte »).',
  },
  refusedPaused: {
    en: 'Refused: the bridge asked to wait (429 / 5xx), {seconds} s left. Nothing sent.',
    fr: 'Refusé : le pont a demandé d’attendre (429 / 5xx), encore {seconds} s. Rien envoyé.',
  },
  refusedPending: {
    en: 'Refused: a lock is in progress. Nothing sent.',
    fr: 'Refusé : un verrouillage est en cours. Rien envoyé.',
  },
  refusedLockedAfter: {
    en: 'Refused: a lock was asked meanwhile. Nothing sent.',
    fr: 'Refusé : un verrouillage a été demandé entre-temps. Rien envoyé.',
  },
  refusedNoCommand: {
    en: 'Refused: no valid key id or local key. Nothing sent.',
    fr: 'Refusé : pas de numéro de clé ni de clé locale valides. Rien envoyé.',
  },
  refusedKey: {
    en: 'Refused: the bridge refused the local key. Nothing sent.',
    fr: 'Refusé : le pont a refusé la clé locale. Rien envoyé.',
  },
  refusedIdentity: {
    en: 'Refused: the bridge at this address is not the one of this device, or not identified yet. Nothing sent.',
    fr: 'Refusé : le pont à cette adresse n’est pas celui de cet appareil, ou pas encore identifié. Rien envoyé.',
  },
  refusedData: {
    en: 'Refused: /data cannot be read or written. Nothing sent.',
    fr: 'Refusé : /data ne peut être lu ou écrit. Rien envoyé.',
  },
  refusedRead: {
    en: 'Refused: the bridge could not be read just now. Nothing sent.',
    fr: 'Refusé : le pont n’a pas pu être lu à l’instant. Rien envoyé.',
  },
  refusedOffline: {
    en: 'Refused: the lock is not connected to the bridge. Nothing sent.',
    fr: 'Refusé : la serrure n’est pas connectée au pont. Rien envoyé.',
  },
  refusedState: {
    en: 'Refused: the lock is moving, jammed or in an unknown state. Nothing sent.',
    fr: 'Refusé : la serrure est en mouvement, bloquée ou dans un état inconnu. Rien envoyé.',
  },
  refusedLate: {
    en: 'Refused: it could not leave in time. Nothing sent.',
    fr: 'Refusé : la commande n’a pas pu partir à temps. Rien envoyé.',
  },
  refusedBusy: {
    en: 'Refused: another command of this lock is in progress. Nothing sent.',
    fr: 'Refusé : une autre commande de cette serrure est en cours. Rien envoyé.',
  },
  refusedNotSent: {
    en: 'The bridge could not be reached. Nothing sent.',
    fr: 'Le pont n’a pas pu être joint. Rien envoyé.',
  },
  alreadyUnlocked: {
    en: 'Already unlocked: nothing sent.',
    fr: 'Déjà déverrouillée : rien envoyé.',
  },
  sentNoAnswer: {
    en: 'Sent, without confirmation: the lock may move. It is read again.',
    fr: 'Envoyée, sans confirmation : la serrure peut bouger. Elle est relue.',
  },
  sentError: {
    en: 'The bridge answered an error: the lock may not have moved. It is read again.',
    fr: 'Le pont a répondu une erreur : la serrure n’a peut-être pas bougé. Elle est relue.',
  },
  unlockSent: {
    en: 'Unlock sent; waiting for the lock to confirm.',
    fr: 'Déverrouillage envoyé ; en attente de la confirmation de la serrure.',
  },
  openSent: {
    en: 'Open sent; waiting for the lock to confirm.',
    fr: 'Ouverture envoyée ; en attente de la confirmation de la serrure.',
  },
  unlockConfirmed: {
    en: 'Unlocked (confirmed by the lock).',
    fr: 'Déverrouillée (confirmé par la serrure).',
  },
  openConfirmed: {
    en: 'Opened (confirmed by the lock).',
    fr: 'Ouverte (confirmé par la serrure).',
  },
  unknownFeature: { en: 'Unknown feature.', fr: 'Fonctionnalité inconnue.' },
  badValue: { en: 'Only the value 1 is accepted.', fr: 'Seule la valeur 1 est acceptée.' },
};

/** Answers of the configuration actions. */
export const A = {
  testWait: {
    en: 'Tested a moment ago (never faster than the refresh interval): try again in {seconds} s.',
    fr: 'Testé il y a peu (jamais plus vite que l’intervalle de rafraîchissement) : réessayez dans {seconds} s.',
  },
  testNoConfig: {
    en: 'Enter the IP address of the bridge first.',
    fr: 'Saisissez d’abord l’adresse IP du pont.',
  },
  testOk: {
    en: 'Bridge {mac} answers; lock {position}, battery {battery}. Webhooks: {hooks}. The local key is checked by the first command only.',
    fr: 'Le pont {mac} répond ; serrure {position}, batterie {battery}. Webhooks : {hooks}. La clé locale n’est vérifiée que par la première commande.',
  },
  testPaused: {
    en: 'The bridge asked to wait (429 / 5xx): not read for {seconds} s more.',
    fr: 'Le pont a demandé d’attendre (429 / 5xx) : pas de lecture avant {seconds} s.',
  },
  testFailed: { en: 'The bridge does not answer.', fr: 'Le pont ne répond pas.' },
  testBadAnswer: {
    en: 'Something answers, but not a LOQED bridge.',
    fr: 'Quelque chose répond, mais pas un pont LOQED.',
  },
  testOther: {
    en: 'Another bridge ({mac}) answers at this address: press "Use the bridge now answering" twice to use it.',
    fr: 'Un autre pont ({mac}) répond à cette adresse : utilisez deux fois « Utiliser le pont qui répond maintenant » pour le prendre.',
  },
  hooksOk: { en: 'registered', fr: 'inscrit' },
  hooksOff: { en: 'off', fr: 'désactivés' },
  hooksRefused: { en: 'bridge key refused', fr: 'clé du pont refusée' },
  hooksFailed: { en: 'could not be registered', fr: 'inscription impossible' },
  adoptNone: {
    en: 'The bridge answering is the one in use: nothing to do.',
    fr: 'Le pont qui répond est celui utilisé : rien à faire.',
  },
  adoptConfirm: {
    en: 'Bridge {mac} answers. Press again within a minute to use it (its lock becomes a new device).',
    fr: 'Le pont {mac} répond. Appuyez encore dans la minute pour l’utiliser (sa serrure devient un nouvel appareil).',
  },
  adoptDone: { en: 'Bridge {mac} is now used.', fr: 'Le pont {mac} est désormais utilisé.' },
  adoptFailed: {
    en: 'The bridge could not be read: nothing changed.',
    fr: 'Le pont n’a pas pu être lu : rien n’a changé.',
  },
  adoptData: {
    en: '/data cannot be written: nothing changed.',
    fr: '/data ne peut être écrit : rien n’a changé.',
  },
  unknown: { en: 'unknown', fr: 'inconnue' },
};

/** "{name}" placeholders filled with plain values. */
export function fill(text, values = {}) {
  return text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}

/** A multi-language message object with placeholders filled. */
export function message(entry, values) {
  return { en: fill(entry.en, values), fr: fill(entry.fr, values) };
}
