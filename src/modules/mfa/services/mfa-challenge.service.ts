/**
 * Responsabilidade: emitir e resolver o desafio de MFA — o estado do login que parou entre a
 * senha e o segundo fator.
 * Consumido por: o `AuthService`, através da `PortaDeMfa`.
 * Regras:
 *  - Desafio opaco de 32 bytes, guardado como `sha256` com TTL curto. Um JWT aqui não daria
 *    revogação no primeiro uso nem contagem de tentativas, que são as duas coisas de que
 *    este fluxo depende.
 *  - Uso único de verdade: o sucesso é `findOneAndDelete`, atômico. Dois `verify` simultâneos
 *    com o mesmo desafio produzem no máximo um par de tokens.
 *  - Resposta única para toda falha. Desafio inexistente, expirado, esgotado e código errado
 *    devolvem `null` — o motivo vive na métrica e no log.
 *  - Teto de tentativas por desafio: estourou, o desafio morre e a pessoa refaz o login. É o
 *    que torna o espaço de um milhão de códigos inalcançável por força bruta.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  DesafioEmitido,
  DesafioResolvido,
  PortaDeMfa,
  RespostaAoDesafio,
} from '../../auth/interfaces/mfa.port.js';
import { decifrarSegredoDoFator } from './secret-envelope.js';
import { validarCodigo } from './totp.js';
import { digerirCodigo } from './recovery-codes.js';
import { medidorDeMfaNulo, type MedidorDeMfa } from '../metrics/mfa.metrics.js';
import type { RepositorioDeFatorDeMfa } from '../repositories/mfa-factor.repository.js';
import type { RepositorioDeCodigosDeRecuperacao } from '../repositories/recovery-code.repository.js';
import type { RepositorioDeDesafioDeMfa } from '../repositories/mfa-challenge.repository.js';

export interface DependenciasDoDesafioDeMfa {
  readonly fatores: RepositorioDeFatorDeMfa;
  readonly codigos: RepositorioDeCodigosDeRecuperacao;
  readonly desafios: RepositorioDeDesafioDeMfa;
  readonly masterKey: string;
  readonly ttlMs: number;
  readonly maxTentativas: number;
  readonly janela?: number;
  readonly medidor?: MedidorDeMfa;
}

/** O token em claro nunca é gravado — só este digest. */
function digerirToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function criarServicoDeDesafioDeMfa(deps: DependenciasDoDesafioDeMfa): PortaDeMfa {
  const medidor = deps.medidor ?? medidorDeMfaNulo();

  return {
    async desafiar(userId: string): Promise<DesafioEmitido | null> {
      const fator = await deps.fatores.buscarAtivo(userId);
      if (fator === null) {
        return null;
      }

      const token = randomBytes(32).toString('base64url');
      await deps.desafios.criar({
        tokenHash: digerirToken(token),
        userId,
        expiraEm: new Date(Date.now() + deps.ttlMs),
      });

      medidor.contarDesafio();
      return { token, expiraEmSegundos: Math.floor(deps.ttlMs / 1000) };
    },

    async resolver(
      mfaToken: string,
      resposta: RespostaAoDesafio,
    ): Promise<DesafioResolvido | null> {
      const hash = digerirToken(mfaToken);
      const desafio = await deps.desafios.buscar(hash);
      if (desafio === null) {
        return null;
      }
      if (desafio.tentativas >= deps.maxTentativas) {
        await deps.desafios.remover(hash);
        return null;
      }

      /** Falha contada: no teto, o desafio morre e o login inteiro é refeito. */
      async function recusar(metodo: 'totp' | 'recovery'): Promise<null> {
        const tentativas = await deps.desafios.registrarFalha(hash);
        if (tentativas >= deps.maxTentativas) {
          await deps.desafios.remover(hash);
        }
        medidor.contarVerificacao(metodo, 'failure');
        return null;
      }

      if (resposta.codigoDeRecuperacao !== undefined) {
        const gasto = await deps.codigos.consumir(
          desafio.userId,
          digerirCodigo(resposta.codigoDeRecuperacao),
        );
        if (!gasto) {
          return recusar('recovery');
        }
        if ((await deps.desafios.consumir(hash)) === null) {
          // Outro pedido levou o desafio no meio do caminho. O código já foi gasto, mas
          // emitir token aqui daria dois pares para um desafio de uso único.
          return null;
        }
        medidor.contarVerificacao('recovery', 'success');
        return { userId: desafio.userId, metodo: 'recovery' };
      }

      if (resposta.codigo === undefined) {
        return recusar('totp');
      }

      const fator = await deps.fatores.buscarAtivo(desafio.userId);
      if (fator === null) {
        return null;
      }

      const segredo = decifrarSegredoDoFator(fator.segredoCifrado, deps.masterKey);
      const aceito = validarCodigo(segredo, resposta.codigo, {
        passoMinimo: fator.ultimoPasso,
        ...(deps.janela === undefined ? {} : { janela: deps.janela }),
      });
      if (aceito === null) {
        // Distingue código errado de código correto porém já consumido. O segundo caso é
        // interceptação — alguém viu o código na tela ou no meio do caminho e o repetiu —
        // e merece contador próprio, não se perder junto com erro de digitação.
        const seriaValidoSemAntiReplay = validarCodigo(segredo, resposta.codigo, {
          ...(deps.janela === undefined ? {} : { janela: deps.janela }),
        });
        if (seriaValidoSemAntiReplay !== null) {
          medidor.contarReplayBloqueado();
        }
        return recusar('totp');
      }

      if ((await deps.desafios.consumir(hash)) === null) {
        return null;
      }
      await deps.fatores.registrarUso(fator.id, aceito.passo);
      medidor.contarVerificacao('totp', 'success');
      return { userId: desafio.userId, metodo: 'otp' };
    },
  };
}
