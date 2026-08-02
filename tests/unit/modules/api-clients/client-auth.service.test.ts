/**
 * Cobre a autenticação de cliente: a falha genérica única, o hash fantasma que equaliza o
 * tempo do caminho "não existe", a aceitação do segredo anterior dentro da sobreposição e o
 * registro de uso que nunca derruba quem já se autenticou.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarClientAuthService,
  type ClientAuthService,
} from '../../../../src/modules/api-clients/services/client-auth.service.js';
import { criarServicoDeSenha } from '../../../../src/shared/crypto/password.service.js';
import { criarLogger } from '../../../../src/shared/logger/index.js';
import type { RepositorioDeClientes } from '../../../../src/modules/api-clients/repositories/api-client.repository.js';
import type {
  CredenciaisDoCliente,
  StatusDoCliente,
} from '../../../../src/modules/api-clients/types/api-client.types.js';
import type { MotivoDeFalhaDeCliente } from '../../../../src/modules/api-clients/metrics/api-clients.metrics.js';

// Custo baixo: estes testes exercitam a lógica, não o fator de trabalho do scrypt.
const servicoDeSenha = criarServicoDeSenha({ custo: 2 ** 12, blocos: 8, paralelismo: 1 });
const logger = criarLogger({ nivel: 'fatal' });

const SEGREDO = 'segredo-corrente-do-cliente';
const SEGREDO_ANTERIOR = 'segredo-anterior-do-cliente';
const T0 = 1_800_000_000_000;

let relogio = T0;
let registrarUso: ReturnType<typeof vi.fn>;
let falhas: MotivoDeFalhaDeCliente[];
let sucessos: number;

interface Cenario {
  readonly service: ClientAuthService;
  readonly credenciais: CredenciaisDoCliente | null;
}

async function montar(
  opcoes: {
    status?: StatusDoCliente;
    comAnterior?: boolean;
    anteriorExpiraEm?: number;
    existe?: boolean;
  } = {},
): Promise<Cenario> {
  const {
    status = 'active',
    comAnterior = false,
    anteriorExpiraEm = T0 + 3_600_000,
    existe = true,
  } = opcoes;

  const credenciais: CredenciaisDoCliente | null = existe
    ? {
        id: 'id-interno',
        clientId: 'cli_publico',
        status,
        secretHash: await servicoDeSenha.gerarHash(SEGREDO),
        previousSecretHash: comAnterior ? await servicoDeSenha.gerarHash(SEGREDO_ANTERIOR) : null,
        previousSecretExpiresAt: comAnterior ? new Date(anteriorExpiraEm) : null,
        escopos: ['orders:read'],
        grantTypes: ['client_credentials'],
        accessTokenTtlSegundos: null,
        ultimoUsoEm: null,
      }
    : null;

  const repo = {
    buscarPorClientId: () => Promise.resolve(credenciais),
    registrarUso,
  } as unknown as RepositorioDeClientes;

  const service = criarClientAuthService({
    repo,
    servicoDeSenha,
    logger,
    throttleDeUsoMs: 300_000,
    agora: () => relogio,
    medidor: {
      contarFalhaDeAutenticacao: (motivo) => falhas.push(motivo),
      contarSucessoDeAutenticacao: () => (sucessos += 1),
      registrarContagem: vi.fn(),
      contarCriacao: vi.fn(),
      contarAtualizacao: vi.fn(),
      contarRemocao: vi.fn(),
      contarRotacaoDeSegredo: vi.fn(),
    },
  });

  return { service, credenciais };
}

beforeEach(() => {
  relogio = T0;
  registrarUso = vi.fn(() => Promise.resolve());
  falhas = [];
  sucessos = 0;
});

describe('caminho feliz', () => {
  it('autentica com o segredo corrente e devolve escopos e grants', async () => {
    const { service } = await montar();

    const cliente = await service.autenticar('cli_publico', SEGREDO);

    expect(cliente).toMatchObject({
      id: 'id-interno',
      clientId: 'cli_publico',
      escopos: ['orders:read'],
      grantTypes: ['client_credentials'],
    });
    expect(sucessos).toBe(1);
  });

  it('registra o uso com o throttle configurado', async () => {
    const { service } = await montar();

    await service.autenticar('cli_publico', SEGREDO);

    expect(registrarUso).toHaveBeenCalledWith('id-interno', 300_000);
  });

  // Inventário, não decisão: quem já provou a credencial não pode ser derrubado por isso.
  it('não derruba a autenticação quando o registro de uso falha', async () => {
    registrarUso = vi.fn(() => Promise.reject(new Error('banco fora')));
    const { service } = await montar();

    await expect(service.autenticar('cli_publico', SEGREDO)).resolves.not.toBeNull();
  });
});

describe('sobreposição de segredo', () => {
  it('aceita o segredo anterior enquanto a janela está viva', async () => {
    const { service } = await montar({ comAnterior: true });

    await expect(service.autenticar('cli_publico', SEGREDO_ANTERIOR)).resolves.not.toBeNull();
  });

  it('recusa o segredo anterior depois de a janela fechar', async () => {
    const { service } = await montar({ comAnterior: true, anteriorExpiraEm: T0 - 1 });

    expect(await service.autenticar('cli_publico', SEGREDO_ANTERIOR)).toBeNull();
  });

  it('o corrente continua valendo durante a sobreposição', async () => {
    const { service } = await montar({ comAnterior: true });

    await expect(service.autenticar('cli_publico', SEGREDO)).resolves.not.toBeNull();
  });

  // Um deploy atrasado e um ataque não são a mesma coisa para quem lê o alerta.
  it('distingue no motivo quem tentou um segredo que já foi do cliente', async () => {
    const { service } = await montar({ comAnterior: true, anteriorExpiraEm: T0 - 1 });

    await service.autenticar('cli_publico', SEGREDO_ANTERIOR);

    expect(falhas).toEqual(['expired_previous']);
  });
});

describe('falha genérica única', () => {
  it('devolve null para cliente inexistente', async () => {
    const { service } = await montar({ existe: false });

    expect(await service.autenticar('cli_naoexiste', SEGREDO)).toBeNull();
    expect(falhas).toEqual(['unknown_client']);
  });

  it('devolve null para segredo errado', async () => {
    const { service } = await montar();

    expect(await service.autenticar('cli_publico', 'errado')).toBeNull();
    expect(falhas).toEqual(['bad_secret']);
  });

  it('devolve null para cliente desabilitado, mesmo com o segredo certo', async () => {
    const { service } = await montar({ status: 'disabled' });

    expect(await service.autenticar('cli_publico', SEGREDO)).toBeNull();
    expect(falhas).toEqual(['disabled']);
  });

  it('devolve null para cliente removido, mesmo com o segredo certo', async () => {
    const { service } = await montar({ status: 'deleted' });

    expect(await service.autenticar('cli_publico', SEGREDO)).toBeNull();
  });

  // Dizer ao chamador qual dos quatro ocorreu entrega um oráculo de enumeração de graça.
  it('todos os caminhos de falha devolvem exatamente o mesmo valor', async () => {
    const inexistente = await (await montar({ existe: false })).service.autenticar('x', SEGREDO);
    const errado = await (await montar()).service.autenticar('cli_publico', 'errado');
    const desabilitado = await (
      await montar({ status: 'disabled' })
    ).service.autenticar('cli_publico', SEGREDO);

    expect(inexistente).toBeNull();
    expect(errado).toBeNull();
    expect(desabilitado).toBeNull();
  });

  it('não registra uso em nenhum caminho de falha', async () => {
    const { service } = await montar();

    await service.autenticar('cli_publico', 'errado');

    expect(registrarUso).not.toHaveBeenCalled();
  });
});

describe('equalização de tempo', () => {
  // Sem o hash fantasma, o caminho "não existe" volta em microssegundos e o legítimo em
  // ~100 ms: a diferença sozinha denuncia quais identificadores existem.
  it('paga o custo do scrypt também para cliente inexistente', async () => {
    const verificar = vi.spyOn(servicoDeSenha, 'verificar');
    const { service } = await montar({ existe: false });

    await service.autenticar('cli_naoexiste', SEGREDO);

    expect(verificar).toHaveBeenCalled();
    verificar.mockRestore();
  });

  it('paga o custo do scrypt também para cliente desabilitado', async () => {
    const verificar = vi.spyOn(servicoDeSenha, 'verificar');
    const { service } = await montar({ status: 'disabled' });

    await service.autenticar('cli_publico', SEGREDO);

    expect(verificar).toHaveBeenCalled();
    verificar.mockRestore();
  });

  it('a diferença média entre inexistente e segredo errado fica abaixo de 20%', async () => {
    const amostras = 12;
    const cenarioInexistente = await montar({ existe: false });
    const cenarioErrado = await montar();

    // Aquece: o hash fantasma é gerado uma vez por instância e memoizado, então só a
    // primeira chamada paga o scrypt extra. Em produção isso acontece no primeiro pedido
    // da vida do processo, não a cada requisição — medir com ele frio compararia coisas
    // diferentes.
    await cenarioInexistente.service.autenticar('cli_naoexiste', SEGREDO);
    await cenarioErrado.service.autenticar('cli_publico', 'errado');

    async function medir(fn: () => Promise<unknown>): Promise<number> {
      const inicio = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - inicio) / 1e6;
    }

    let tempoInexistente = 0;
    let tempoErrado = 0;
    for (let i = 0; i < amostras; i += 1) {
      tempoInexistente += await medir(() =>
        cenarioInexistente.service.autenticar('cli_naoexiste', SEGREDO),
      );
      tempoErrado += await medir(() => cenarioErrado.service.autenticar('cli_publico', 'errado'));
    }

    const mediaInexistente = tempoInexistente / amostras;
    const mediaErrado = tempoErrado / amostras;
    const diferenca =
      Math.abs(mediaInexistente - mediaErrado) / Math.max(mediaInexistente, mediaErrado);

    expect(diferenca).toBeLessThan(0.2);
  });
});
