/**
 * Cobre o serviço de chaves: cache com hit/invalidação/TTL, decifra fail-closed no boot
 * (MASTER_KEY ausente ou errada com chave active presente), a chave active que assina um
 * token verificável pelo conjunto público, e o registro da contagem no medidor.
 */
import { describe, expect, it, vi } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import {
  criarJwksService,
  type ConfiguracaoJwks,
} from '../../../../src/modules/jwks/services/jwks.service.js';
import type { RepositorioJwks } from '../../../../src/modules/jwks/repositories/jwks.repository.js';
import { gerarParEd25519 } from '../../../../src/modules/jwks/services/key-factory.js';
import { cifrarPrivada } from '../../../../src/shared/crypto/key-envelope.js';
import type { ChaveJwks, StatusDaChave } from '../../../../src/modules/jwks/types/jwks.types.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';

async function novaChave(status: StatusDaChave): Promise<ChaveJwks> {
  const { kid, publicJwk, privateKeyDer } = await gerarParEd25519();
  return {
    kid,
    algorithm: 'EdDSA',
    publicJwk,
    privateKeyEnc: cifrarPrivada(privateKeyDer, MASTER),
    status,
    criadaEm: new Date(),
    ativadaEm: status === 'active' ? new Date() : null,
    aposentadaEm: null,
    verificavelAte: null,
  };
}

function repoFake(chaves: ChaveJwks[]): { repo: RepositorioJwks; chamadasElegiveis: () => number } {
  let chamadas = 0;
  const repo: RepositorioJwks = {
    inserir: () => Promise.reject(new Error('não usado')),
    rotacionar: () => Promise.reject(new Error('não usado')),
    revogar: () => Promise.reject(new Error('não usado')),
    purgar: () => Promise.reject(new Error('não usado')),
    obterMetadadosPorKid: () => Promise.resolve(null),
    listarElegiveis: () => {
      chamadas += 1;
      return Promise.resolve(chaves);
    },
    listarMetadados: () => Promise.resolve(chaves),
    obterAtiva: () => Promise.resolve(chaves.find((c) => c.status === 'active') ?? null),
    obterProxima: () => Promise.resolve(chaves.find((c) => c.status === 'next') ?? null),
    contarPorStatus: () =>
      Promise.resolve({
        active: chaves.filter((c) => c.status === 'active').length,
        next: chaves.filter((c) => c.status === 'next').length,
        retired: chaves.filter((c) => c.status === 'retired').length,
      }),
  };
  return { repo, chamadasElegiveis: () => chamadas };
}

function config(repo: RepositorioJwks, extra: Partial<ConfiguracaoJwks> = {}): ConfiguracaoJwks {
  return { repo, masterKey: MASTER, cacheTtlMs: 300_000, ...extra };
}

describe('cache', () => {
  it('serve do cache sem reconsultar dentro do TTL', async () => {
    const { repo, chamadasElegiveis } = repoFake([await novaChave('active')]);
    const service = criarJwksService(config(repo));

    await service.obterConjuntoPublico();
    await service.obterConjuntoPublico();
    await service.obterConjuntoDeVerificacao();

    expect(chamadasElegiveis()).toBe(1);
  });

  it('invalidar força recarga na próxima leitura', async () => {
    const { repo, chamadasElegiveis } = repoFake([await novaChave('active')]);
    const service = criarJwksService(config(repo));

    await service.obterConjuntoPublico();
    service.invalidar();
    await service.obterConjuntoPublico();

    expect(chamadasElegiveis()).toBe(2);
  });

  it('recarrega quando o TTL de segurança expira', async () => {
    const { repo, chamadasElegiveis } = repoFake([await novaChave('active')]);
    let t = 1_000;
    const service = criarJwksService(config(repo, { cacheTtlMs: 500, agora: () => t }));

    await service.obterConjuntoPublico();
    t += 600; // além do TTL
    await service.obterConjuntoPublico();

    expect(chamadasElegiveis()).toBe(2);
  });

  it('publica as chaves elegíveis no conjunto público', async () => {
    const ativa = await novaChave('active');
    const { repo } = repoFake([ativa, await novaChave('next')]);
    const service = criarJwksService(config(repo));

    const { keys } = await service.obterConjuntoPublico();
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.kid === ativa.kid)).toBe(true);
    expect(keys.every((k) => !('d' in k))).toBe(true);
  });
});

describe('obterChaveAtiva', () => {
  it('devolve a active que assina um token verificável pelo conjunto público', async () => {
    const { repo } = repoFake([await novaChave('active')]);
    const service = criarJwksService(config(repo));

    const ativa = await service.obterChaveAtiva();
    const token = await new SignJWT({ scope: 'x' })
      .setProtectedHeader({ alg: 'EdDSA', kid: ativa.kid })
      .sign(ativa.privateKey.usar());

    const verificacao = await service.obterConjuntoDeVerificacao();
    const { protectedHeader } = await jwtVerify(token, verificacao, { algorithms: ['EdDSA'] });
    expect(protectedHeader.kid).toBe(ativa.kid);
  });

  it('rejeita quando não há chave active, mas o conjunto público segue disponível', async () => {
    const { repo } = repoFake([await novaChave('next')]);
    const service = criarJwksService(config(repo));

    await expect(service.obterChaveAtiva()).rejects.toThrow();
    expect((await service.obterConjuntoPublico()).keys).toHaveLength(1);
  });
});

describe('fail closed no boot', () => {
  it('rejeita iniciar quando a MASTER_KEY está errada e há chave active', async () => {
    const { repo } = repoFake([await novaChave('active')]);
    const service = criarJwksService(
      config(repo, { masterKey: 'master-key-errada-com-32-bytes-xxx' }),
    );

    await expect(service.iniciar()).rejects.toThrow();
  });

  it('rejeita iniciar quando a MASTER_KEY está ausente e há chave active', async () => {
    const { repo } = repoFake([await novaChave('active')]);
    const service = criarJwksService({
      repo,
      cacheTtlMs: 300_000,
    });

    await expect(service.iniciar()).rejects.toThrow();
  });

  it('sobe sem chave active (nada a decifrar)', async () => {
    const { repo } = repoFake([]);
    const service = criarJwksService(config(repo));

    await expect(service.iniciar()).resolves.toBeUndefined();
  });
});

describe('métrica', () => {
  it('registra a contagem por estado a cada carga', async () => {
    const { repo } = repoFake([await novaChave('active'), await novaChave('next')]);
    const registrarContagem = vi.fn();
    const service = criarJwksService(
      config(repo, {
        medidor: { registrarContagem, contarRotacao: vi.fn(), registrarIdadeDaAtiva: vi.fn() },
      }),
    );

    await service.obterConjuntoPublico();
    expect(registrarContagem).toHaveBeenCalledWith({ active: 1, next: 1, retired: 0 });
  });
});
