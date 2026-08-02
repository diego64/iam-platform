/**
 * Responsabilidade: autenticar um cliente de API pelo par client_id/client_secret.
 * Consumido por: a emissão de token OAuth2, que troca o par por um access token.
 * Regras:
 *  - **Falha genérica única.** Cliente inexistente, removido, desabilitado e segredo errado
 *    devolvem exatamente o mesmo `null`. O motivo real vive só na métrica e no log — dizer
 *    ao chamador qual dos quatro ocorreu entrega um oráculo de enumeração de graça.
 *  - **O `scrypt` roda sempre**, inclusive para cliente inexistente, comparando contra um
 *    hash fantasma. Sem isso o caminho "não existe" retorna em microssegundos e o caminho
 *    legítimo em ~100 ms, e a diferença por si só denuncia quais identificadores existem.
 *  - O segredo anterior é aceito enquanto a sobreposição estiver viva — é o que permite ao
 *    cliente trocar de credencial sem uma janela de indisponibilidade durante o deploy.
 *  - Registrar o uso é o último passo e nunca derruba a autenticação: é telemetria de
 *    inventário, não parte da decisão.
 */
import type { Logger } from '../../../shared/logger/index.js';
import type { ServicoDeSenha } from '../../../shared/crypto/password.service.js';
import type { RepositorioDeClientes } from '../repositories/api-client.repository.js';
import type { ClienteAutenticado, CredenciaisDoCliente } from '../types/api-client.types.js';
import {
  medidorDeClientesNulo,
  type MedidorDeClientes,
  type MotivoDeFalhaDeCliente,
} from '../metrics/api-clients.metrics.js';

export interface ConfiguracaoDeAutenticacaoDeCliente {
  readonly repo: RepositorioDeClientes;
  readonly servicoDeSenha: ServicoDeSenha;
  readonly logger: Logger;
  /** Intervalo mínimo entre regravações do último uso. */
  readonly throttleDeUsoMs: number;
  readonly medidor?: MedidorDeClientes;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface ClientAuthService {
  /**
   * Devolve o cliente quando o par é válido e o cliente está ativo; `null` em qualquer
   * outra situação. O motivo real fica na métrica e no log, nunca no retorno.
   */
  autenticar(clientId: string, secret: string): Promise<ClienteAutenticado | null>;
}

export function criarClientAuthService(
  config: ConfiguracaoDeAutenticacaoDeCliente,
): ClientAuthService {
  const medidor = config.medidor ?? medidorDeClientesNulo();
  const agora = config.agora ?? Date.now;

  // Gerado uma vez e reusado: o custo de gerá-lo é o mesmo do hash real, e regerá-lo a cada
  // tentativa acrescentaria um segundo scrypt ao caminho de falha, tornando-o mais lento
  // que o legítimo — o vazamento de timing ao contrário.
  let fantasma: Promise<string> | undefined;
  function hashFantasma(): Promise<string> {
    fantasma ??= config.servicoDeSenha.hashFantasma();
    return fantasma;
  }

  function negar(motivo: MotivoDeFalhaDeCliente, clientId: string): null {
    medidor.contarFalhaDeAutenticacao(motivo);
    // O identificador entra no log só quando ele existe: registrar o que veio na requisição
    // encheria o log com lixo de quem varre identificadores.
    config.logger.warn(
      { motivo, client_id: motivo === 'unknown_client' ? null : clientId },
      'clients.auth: autenticação de cliente recusada',
    );
    return null;
  }

  /** `true` se o segredo casa com o corrente ou com o anterior ainda vivo. */
  async function segredoConfere(
    credenciais: CredenciaisDoCliente,
    secret: string,
  ): Promise<{ ok: boolean; usouAnterior: boolean }> {
    if (await config.servicoDeSenha.verificar(secret, credenciais.secretHash)) {
      return { ok: true, usouAnterior: false };
    }

    const anterior = credenciais.previousSecretHash;
    const expira = credenciais.previousSecretExpiresAt;
    if (anterior !== null && expira !== null && expira.getTime() > agora()) {
      if (await config.servicoDeSenha.verificar(secret, anterior)) {
        return { ok: true, usouAnterior: true };
      }
    }

    return { ok: false, usouAnterior: false };
  }

  return {
    async autenticar(clientId: string, secret: string): Promise<ClienteAutenticado | null> {
      const credenciais = await config.repo.buscarPorClientId(clientId);

      if (credenciais === null) {
        // Paga o mesmo custo do caminho legítimo antes de recusar.
        await config.servicoDeSenha.verificar(secret, await hashFantasma());
        return negar('unknown_client', clientId);
      }

      if (credenciais.status !== 'active') {
        await config.servicoDeSenha.verificar(secret, await hashFantasma());
        return negar('disabled', clientId);
      }

      const { ok, usouAnterior } = await segredoConfere(credenciais, secret);
      if (!ok) {
        // Distingue no rótulo da métrica quem tentou o segredo que acabou de expirar de quem
        // mandou um segredo qualquer: o primeiro é um deploy atrasado, o segundo é ataque.
        const motivo: MotivoDeFalhaDeCliente =
          credenciais.previousSecretHash !== null ? 'expired_previous' : 'bad_secret';
        return negar(motivo, clientId);
      }

      medidor.contarSucessoDeAutenticacao();
      if (usouAnterior) {
        config.logger.info(
          { client_id: credenciais.clientId },
          'clients.auth: autenticado com o segredo anterior — a sobreposição ainda está viva',
        );
      }

      // Inventário, não decisão: uma falha aqui não pode derrubar quem se autenticou.
      config.repo.registrarUso(credenciais.id, config.throttleDeUsoMs).catch((erro: unknown) => {
        config.logger.warn({ err: erro }, 'clients.auth: falha ao registrar o último uso');
      });

      return {
        id: credenciais.id,
        clientId: credenciais.clientId,
        escopos: credenciais.escopos,
        grantTypes: credenciais.grantTypes,
        accessTokenTtlSegundos: credenciais.accessTokenTtlSegundos,
      };
    },
  };
}
