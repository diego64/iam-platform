/**
 * Responsabilidade: montar o documento de metadados do servidor de autorização (RFC 8414).
 * Consumido por: a rota `GET /.well-known/oauth-authorization-server`.
 * Regras:
 *  - O documento descreve o que o servidor **faz agora**, não o que ele saberia fazer: com o
 *    `password` grant desligado, ele some da lista. Anunciar um grant que responde
 *    `unsupported_grant_type` mandaria o cliente integrar com um caminho morto.
 *  - `response_types_supported` é lista vazia de propósito — sem `authorization_code`, não há
 *    response type. Omitir o campo sugeriria que o servidor esqueceu de declará-lo.
 *  - Os escopos vêm do catálogo de permissões, em cache curto: é a lista que muda em escala
 *    de dias e seria uma ida ao banco por requisição de descoberta.
 */

export interface ConfiguracaoDeMetadados {
  readonly emissor: string;
  readonly urlBase: string;
  readonly passwordGrantHabilitado: boolean;
  /** Nomes de permissão publicáveis como escopo. */
  readonly listarEscopos: () => Promise<readonly string[]>;
  readonly cacheTtlMs?: number;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface MetadadosDoServidor {
  readonly issuer: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly grant_types_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly scopes_supported: readonly string[];
}

export interface MetadataService {
  obter(): Promise<MetadadosDoServidor>;
}

const TTL_PADRAO_MS = 5 * 60 * 1000;

export function criarMetadataService(config: ConfiguracaoDeMetadados): MetadataService {
  const ttl = config.cacheTtlMs ?? TTL_PADRAO_MS;
  const agora = config.agora ?? Date.now;

  let cache: { documento: MetadadosDoServidor; carregadoEm: number } | null = null;

  const grants = config.passwordGrantHabilitado
    ? ['client_credentials', 'password', 'refresh_token']
    : ['client_credentials', 'refresh_token'];

  return {
    async obter(): Promise<MetadadosDoServidor> {
      if (cache !== null && agora() - cache.carregadoEm < ttl) {
        return cache.documento;
      }

      const escopos = await config.listarEscopos();
      const documento: MetadadosDoServidor = {
        issuer: config.emissor,
        token_endpoint: `${config.urlBase}/oauth/token`,
        jwks_uri: `${config.urlBase}/.well-known/jwks.json`,
        grant_types_supported: grants,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        response_types_supported: [],
        scopes_supported: escopos,
      };

      cache = { documento, carregadoEm: agora() };
      return documento;
    },
  };
}
