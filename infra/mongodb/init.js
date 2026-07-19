// Bootstrap local: cria o banco de sessões e os índices críticos
const db = new Mongo().getDB('iam_sessions');

db.createCollection('refresh_tokens');
db.refresh_tokens.createIndex({ token_hash: 1 }, { unique: true });
db.refresh_tokens.createIndex({ user_id: 1 });
db.refresh_tokens.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // TTL

db.createCollection('token_denylist');
db.token_denylist.createIndex({ jti: 1 }, { unique: true });
db.token_denylist.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }); // TTL
