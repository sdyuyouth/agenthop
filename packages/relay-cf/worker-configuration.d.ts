interface Env {
  ROOM: DurableObjectNamespace;
  CREATE_LIMIT: RateLimit;
  ROOM_CONNECT_LIMIT: RateLimit;
  LOOKUP_LIMIT: RateLimit;
  MISS_LIMIT: RateLimit;
  RELAY_PASS?: string;
}
