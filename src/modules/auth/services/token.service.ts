/**
 * Responsabilidade: emitir o access token (JWT EdDSA) assinado com a chave ativa do JWKS.
 * Consumido por: o `AuthService` (login) e o `OAuthService` (os três grants).
 * Regras:
 *  - Header `{ alg: 'EdDSA', kid }`; claims `sub`, `jti` (UUIDv7), `iat`, `exp`, `iss`,
 *    `aud`, `scope`, `roles`, `perm` (permissões efetivas — base do guard da SPEC 003).
 *  - A chave privada vem do JWKS já decifrada e encapsulada; é usada no último instante
 *    (`.usar()`), sem transitar por objeto logável.
 *  - Token de cliente sai com `sub_type`/`client_id` e **sem** `roles`: cliente não tem papel,
 *    tem escopo. A ausência da claim é o que faz o guard de papel negá-lo por construção.
 *  - Emissor único de propósito: um segundo serviço para token de cliente duplicaria header,
 *    `kid` e formato de claims — dois lugares para a próxima claim nascer torta.
 */
import { SignJWT } from 'jose';
import { uuidv7 } from '../../../shared/crypto/uuidv7.js';
import type { JwksService } from '../../jwks/index.js';

export interface ConfiguracaoDeToken {
  readonly emissor: string;
  readonly audiencia: string;
  readonly ttlSegundos: number;
}

export type TipoDeSujeito = 'user' | 'client';

export interface DadosParaToken {
  readonly sub: string;
  readonly roles: string[];
  /** Permissões efetivas do usuário — vão na claim `perm` para autorização offline. */
  readonly permissions: string[];
  readonly scope: string;
  /** Default `user`. Ausente na claim quando é `user`, para o token do login não mudar. */
  readonly subType?: TipoDeSujeito;
  /** Cliente que pediu o token, quando a emissão passou pelo endpoint de OAuth. */
  readonly clientId?: string;
  /**
   * Como o sujeito se autenticou (RFC 8176): `pwd` sozinho no login de um passo, `pwd`+`otp`
   * ou `pwd`+`recovery` depois do segundo fator. Quem quiser exigir fator forte numa
   * operação crítica precisa distinguir os três.
   */
  readonly amr?: readonly string[];
  /** Atalho para quem só quer saber se houve segundo fator. */
  readonly mfa?: boolean;
}

export interface OpcoesDeEmissao {
  /** Sobrepõe o TTL global — é o `access_token_ttl_seconds` do cliente (SPEC 011). */
  readonly ttlSegundos?: number;
}

export interface TokenEmitido {
  readonly token: string;
  readonly jti: string;
  readonly expiraEm: Date;
  readonly ttlSegundos: number;
}

export interface TokenService {
  emitir(dados: DadosParaToken, opcoes?: OpcoesDeEmissao): Promise<TokenEmitido>;
}

export function criarTokenService(
  jwks: Pick<JwksService, 'obterChaveAtiva'>,
  config: ConfiguracaoDeToken,
): TokenService {
  return {
    async emitir(dados: DadosParaToken, opcoes?: OpcoesDeEmissao): Promise<TokenEmitido> {
      const { kid, privateKey } = await jwks.obterChaveAtiva();
      const jti = uuidv7();
      const iat = Math.floor(Date.now() / 1000);
      const ttlSegundos = opcoes?.ttlSegundos ?? config.ttlSegundos;
      const exp = iat + ttlSegundos;
      const ehCliente = dados.subType === 'client';

      // Claim com valor `undefined` não é serializada (o payload passa por JSON.stringify).
      // É o que mantém o token do login idêntico ao de antes desta SPEC, sem ramificar a
      // construção do payload em duas.
      const token = await new SignJWT({
        scope: dados.scope,
        // Cliente não tem papel: a claim não existe, e `exigirPapel` falha fechado.
        roles: ehCliente ? undefined : dados.roles,
        perm: dados.permissions,
        sub_type: dados.subType,
        client_id: dados.clientId,
        amr: dados.amr,
        mfa: dados.mfa,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid })
        .setSubject(dados.sub)
        .setJti(jti)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .setIssuer(config.emissor)
        .setAudience(config.audiencia)
        .sign(privateKey.usar());

      return { token, jti, expiraEm: new Date(exp * 1000), ttlSegundos };
    },
  };
}
