export type ConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "READY"
  | "IN_GAME";

export type ConnectionSnapshot = {
  enabled: boolean;
  hasPeerTransport: boolean;
  localReady: boolean;
  remoteReady: boolean;
  inGame: boolean;
};

export const deriveConnectionState = ({
  enabled,
  hasPeerTransport,
  localReady,
  remoteReady,
  inGame,
}: ConnectionSnapshot): ConnectionState => {
  if (!enabled) {
    return "DISCONNECTED";
  }

  if (!hasPeerTransport) {
    return "CONNECTING";
  }

  if (inGame && localReady && remoteReady) {
    return "IN_GAME";
  }

  if (localReady && remoteReady) {
    return "READY";
  }

  return "CONNECTED";
};

export const getConnectionBanner = (state: ConnectionState): string => {
  if (state === "DISCONNECTED") {
    return "Disconnected";
  }

  if (state === "CONNECTING") {
    return "Waiting for opponent...";
  }

  if (state === "CONNECTED") {
    return "Opponent connected";
  }

  if (state === "READY") {
    return "Both players ready - Starting duel...";
  }

  return "Duel in progress";
};
