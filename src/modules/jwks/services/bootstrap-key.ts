/**
 * Responsabilidade: garantir que exista uma chave de assinatura active — gera a primeira se
 * faltar, senão não faz nada.
 * Consumido por: o script de bootstrap. Extraído em função para ser testável sem subprocesso.
 * Regras:
 *  - Idempotente: com uma active já presente, é no-op (o índice único parcial também
 *    barraria, mas a checagem evita o erro e deixa a operação repetível).
 *  - Só o `kid` é logado; a privada nunca sai daqui em claro.
 */
import type { Logger } from '../../../shared/logger/index.js';
import { cifrarPrivada } from '../../../shared/crypto/key-envelope.js';
import { gerarParEd25519 } from './key-factory.js';
import type { RepositorioJwks } from '../repositories/jwks.repository.js';

export interface OpcoesDeBootstrapDeChave {
  readonly repo: RepositorioJwks;
  readonly masterKey: string;
  readonly logger: Logger;
}

export interface ResultadoDeBootstrapDeChave {
  readonly criada: boolean;
  readonly kid?: string;
}

export async function garantirChaveDeBootstrap(
  opcoes: OpcoesDeBootstrapDeChave,
): Promise<ResultadoDeBootstrapDeChave> {
  if ((await opcoes.repo.obterAtiva()) !== null) {
    opcoes.logger.info('jwks.bootstrap: chave active já existe — nada a fazer');
    return { criada: false };
  }

  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  await opcoes.repo.inserir({
    kid,
    algorithm: 'EdDSA',
    publicJwk,
    privateKeyEnc: cifrarPrivada(privateKeyDer, opcoes.masterKey),
    status: 'active',
  });
  opcoes.logger.info({ kid }, 'jwks.bootstrap: chave active criada');
  return { criada: true, kid };
}
