/**
 * Responsabilidade: emitir o access token (JWT EdDSA) assinado com a chave ativa do JWKS.
 * Consumido por: o `AuthService` (login).
 * Regras:
 *  - Header `{ alg: 'EdDSA', kid }`; claims `sub`, `jti` (UUIDv7), `iat`, `exp`, `iss`,
 *    `aud`, `scope`, `roles`.
 *  - A chave privada vem do JWKS já decifrada e encapsulada; é usada no último instante
 *    (`.usar()`), sem transitar por objeto logável.
 */
import { SignJWT } from 'jose';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';
import type { JwksService } from '../../jwks/index.js';

export interface ConfiguracaoDeToken {
  readonly emissor: string;
  readonly audiencia: string;
  readonly ttlSegundos: number;
}

export interface DadosParaToken {
  readonly sub: string;
  readonly roles: string[];
  readonly scope: string;
}

export interface TokenEmitido {
  readonly token: string;
  readonly jti: string;
  readonly expiraEm: Date;
}

export interface TokenService {
  emitir(dados: DadosParaToken): Promise<TokenEmitido>;
}

export function criarTokenService(
  jwks: Pick<JwksService, 'obterChaveAtiva'>,
  config: ConfiguracaoDeToken,
): TokenService {
  return {
    async emitir(dados: DadosParaToken): Promise<TokenEmitido> {
      const { kid, privateKey } = await jwks.obterChaveAtiva();
      const jti = uuidv7();
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + config.ttlSegundos;

      const token = await new SignJWT({ scope: dados.scope, roles: dados.roles })
        .setProtectedHeader({ alg: 'EdDSA', kid })
        .setSubject(dados.sub)
        .setJti(jti)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setIssuer(config.emissor)
        .setAudience(config.audiencia)
        .sign(privateKey.usar());

      return { token, jti, expiraEm: new Date(exp * 1000) };
    },
  };
}
