// Unique ID for each Claude Code instance (generated on registration)
export type PeerId = string;

export interface Peer {
  id: PeerId;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  last_seen: string; // ISO timestamp
}

export interface Message {
  id: number;
  from_id: PeerId;
  to_id: PeerId;
  text: string;
  sent_at: string; // ISO timestamp
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo" | "machine+remote";
  // The requesting peer's context (used for filtering)
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

// --- v2 broker-to-broker types (cross-host extension) ---

/**
 * Inbound event pushed from a peer broker. UPSERTs / deletes into remote_peers.
 */
export interface PeerEventRequest {
  event_type: "register" | "exit" | "heartbeat" | "summary-change";
  machine: string; // calling broker's machine name (also asserted via HMAC header)
  peer: {
    id: PeerId;
    cwd: string;
    git_root: string | null;
    summary: string;
    registered_at: string;
    last_seen: string;
  };
}

/**
 * Inbound forwarded message to a local peer.
 * The destination broker's /forward inserts into messages with from_id
 * mangled to "<from_id>@<from_machine>" so the recipient can attribute
 * the message to a remote sender.
 */
export interface ForwardRequest {
  from_id: PeerId; // sender's local id (no @ suffix)
  from_machine: string;
  to_id: PeerId; // recipient's local id (no @ suffix)
  text: string;
  sent_at: string;
}

export interface ForwardResponse {
  ok: boolean;
  error?: string;
}

export interface PeerBrokerHealthResponse {
  status: "ok";
  machine: string;
  peer_count: number;
  remote_peer_count: number;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
