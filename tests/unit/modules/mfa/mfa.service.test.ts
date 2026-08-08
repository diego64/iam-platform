/**
 * Cobre o MfaService: cadastro que não sobrescreve fator ativo, confirmação que exige prova
 * de posse, estado, e o step-up por senha na desativação e na regeneração.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  criarMfaService,
  type DependenciasDoMfaService,
  type MfaService,
} from '../../../../src/modules/mfa/services/mfa.service.js';
import { ErroDeMfa } from '../../../../src/modules/mfa/errors/mfa-error.js';
import { gerarCodigo, passoDe } from '../../../../src/modules/mfa/services/totp.js';
import { cifrarSegredo, decifrarSegredo } from '../../../../src/shared/crypto/key-envelope.js';
import type { FatorDeMfa } from '../../../../src/modules/mfa/repositories/mfa-factor.repository.js';
import type { Usuario } from '../../../../src/modules/users/entities/user.entity.js';

const MASTER = 'master-key-de-teste-com-mais-de-32-bytes';
const HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';
const USUARIO: Usuario = {
  id: 'u1',
  email: 'a@iam.local',
  status: 'active',
  passwordHash: HASH,
  criadoEm: new Date(),
  atualizadoEm: new Date(),
};

interface Fakes {
  service: MfaService;
  criarPendente: ReturnType<typeof vi.fn>;
  ativar: ReturnType<typeof vi.fn>;
  substituir: ReturnType<typeof vi.fn>;
  removerFatores: ReturnType<typeof vi.fn>;
  removerCodigos: ReturnType<typeof vi.fn>;
  removerDesafios: ReturnType<typeof vi.fn>;
}

function fatorFake(sobrescritas: Partial<FatorDeMfa> = {}): FatorDeMfa {
  return {
    id: 'f1',
    userId: 'u1',
    status: 'pending',
    segredoCifrado: Buffer.alloc(0),
    label: null,
    ultimoPasso: null,
    confirmadoEm: null,
    ultimoUsoEm: null,
    ...sobrescritas,
  };
}

function montar(opcoes: {
  ativo?: FatorDeMfa | null;
  pendente?: FatorDeMfa | null;
  senhaConfere?: boolean;
  sobrescritas?: Partial<DependenciasDoMfaService>;
}): Fakes {
  const criarPendente = vi.fn((entrada: { userId: string; segredoCifrado: Buffer }) =>
    Promise.resolve(fatorFake({ segredoCifrado: entrada.segredoCifrado })),
  );
  const ativar = vi.fn(() => Promise.resolve(true));
  const substituir = vi.fn(() => Promise.resolve());
  const removerFatores = vi.fn(() => Promise.resolve(1));
  const removerCodigos = vi.fn(() => Promise.resolve());
  const removerDesafios = vi.fn(() => Promise.resolve());

  const service = criarMfaService({
    fatores: {
      buscarAtivo: () => Promise.resolve(opcoes.ativo ?? null),
      buscarPendente: () => Promise.resolve(opcoes.pendente ?? null),
      criarPendente,
      ativar,
      registrarUso: () => Promise.resolve(),
      removerDoUsuario: removerFatores,
    },
    codigos: {
      substituir,
      consumir: () => Promise.resolve(true),
      contarValidos: () => Promise.resolve(7),
      removerDoUsuario: removerCodigos,
    },
    desafios: { removerDoUsuario: removerDesafios },
    usuarios: { buscarPorId: () => Promise.resolve(USUARIO) },
    servicoDeSenha: {
      gerarHash: () => Promise.resolve(HASH),
      verificar: () => Promise.resolve(opcoes.senhaConfere ?? true),
      precisaRehash: () => false,
      hashFantasma: () => Promise.resolve(HASH),
    },
    masterKey: MASTER,
    emissor: 'iam.example.com',
    ...opcoes.sobrescritas,
  });

  return {
    service,
    criarPendente,
    ativar,
    substituir,
    removerFatores,
    removerCodigos,
    removerDesafios,
  };
}

describe('iniciarCadastro', () => {
  it('grava o segredo cifrado e devolve a URI do autenticador', async () => {
    const { service, criarPendente } = montar({});

    const iniciado = await service.iniciarCadastro('u1', 'iPhone');

    expect(iniciado.uriOtpauth).toContain('otpauth://totp/iam.example.com:a%40iam.local');
    expect(iniciado.segredoBase32).toMatch(/^[A-Z2-7]+$/);

    // O que foi para o banco é blob cifrado — e decifra de volta no mesmo segredo.
    const gravado = criarPendente.mock.calls[0]?.[0] as { segredoCifrado: Buffer };
    expect(gravado.segredoCifrado.toString('utf8')).not.toContain(iniciado.segredoBase32);
    expect(decifrarSegredo(gravado.segredoCifrado, MASTER)).toHaveLength(20);
  });

  it('recusa quando já existe fator ativo', async () => {
    // Sobrescrever trocaria o segredo em uso por outro que o usuário ainda não cadastrou.
    const { service, criarPendente } = montar({ ativo: fatorFake({ status: 'active' }) });

    await expect(service.iniciarCadastro('u1', null)).rejects.toMatchObject({
      motivo: 'ja-habilitado',
    });
    expect(criarPendente).not.toHaveBeenCalled();
  });
});

describe('confirmarCadastro', () => {
  /** Fator pendente com um segredo real cifrado, para o código bater de verdade. */
  function pendenteComSegredo(): { fator: FatorDeMfa; codigo: string; passo: number } {
    const segredo = Buffer.from('12345678901234567890', 'ascii');
    const passo = passoDe(Date.now());
    return {
      fator: fatorFake({ segredoCifrado: cifrarSegredo(segredo, MASTER) }),
      codigo: gerarCodigo(segredo, passo),
      passo,
    };
  }

  it('ativa o fator e entrega os códigos de recuperação uma única vez', async () => {
    const { fator, codigo, passo } = pendenteComSegredo();
    const { service, ativar, substituir } = montar({
      pendente: fator,
      ativo: fatorFake({ status: 'active', confirmadoEm: new Date() }),
    });

    const confirmado = await service.confirmarCadastro('u1', codigo);

    expect(ativar).toHaveBeenCalledWith('f1', passo);
    expect(confirmado.codigosDeRecuperacao).toHaveLength(10);
    expect(substituir).toHaveBeenCalledOnce();
  });

  it('código errado mantém o cadastro pendente', async () => {
    const { fator } = pendenteComSegredo();
    const { service, ativar, substituir } = montar({ pendente: fator });

    await expect(service.confirmarCadastro('u1', '000000')).rejects.toMatchObject({
      motivo: 'codigo-invalido',
    });
    expect(ativar).not.toHaveBeenCalled();
    expect(substituir).not.toHaveBeenCalled();
  });

  it('sem cadastro pendente responde não encontrado', async () => {
    const { service } = montar({});

    await expect(service.confirmarCadastro('u1', '123456')).rejects.toMatchObject({
      motivo: 'cadastro-nao-encontrado',
    });
  });
});

describe('estado', () => {
  it('descreve o fator ativo com os códigos restantes', async () => {
    const confirmadoEm = new Date();
    const { service } = montar({ ativo: fatorFake({ status: 'active', confirmadoEm }) });

    await expect(service.estado('u1')).resolves.toEqual({
      habilitado: true,
      status: 'active',
      tipo: 'totp',
      confirmadoEm,
      ultimoUsoEm: null,
      codigosDeRecuperacaoRestantes: 7,
    });
  });

  it('cadastro pendente não conta como habilitado', async () => {
    const { service } = montar({ pendente: fatorFake() });

    const estado = await service.estado('u1');

    expect(estado.habilitado).toBe(false);
    expect(estado.status).toBe('pending');
  });

  it('sem fator nenhum', async () => {
    const { service } = montar({});

    const estado = await service.estado('u1');

    expect(estado).toMatchObject({ habilitado: false, status: 'none', tipo: null });
  });
});

describe('desativar', () => {
  it('exige a senha atual', async () => {
    // Sem o step-up, um access token roubado desligaria o segundo fator da vítima.
    const { service, removerFatores } = montar({ senhaConfere: false });

    await expect(service.desativar('u1', 'errada')).rejects.toMatchObject({
      motivo: 'credencial-invalida',
    });
    expect(removerFatores).not.toHaveBeenCalled();
  });

  it('remove fator, códigos e desafios abertos', async () => {
    const { service, removerFatores, removerCodigos, removerDesafios } = montar({
      ativo: fatorFake({ status: 'active' }),
    });

    await service.desativar('u1', 'correta');

    expect(removerFatores).toHaveBeenCalledWith('u1');
    expect(removerCodigos).toHaveBeenCalledWith('u1');
    expect(removerDesafios).toHaveBeenCalledWith('u1');
  });

  it('sem fator para remover responde não habilitado', async () => {
    const semFator = montar({});
    semFator.removerFatores.mockResolvedValueOnce(0);

    await expect(semFator.service.desativar('u1', 'correta')).rejects.toMatchObject({
      motivo: 'nao-habilitado',
    });
  });
});

describe('regenerarCodigos', () => {
  it('exige a senha atual', async () => {
    const { service, substituir } = montar({
      ativo: fatorFake({ status: 'active' }),
      senhaConfere: false,
    });

    await expect(service.regenerarCodigos('u1', 'errada')).rejects.toMatchObject({
      motivo: 'credencial-invalida',
    });
    expect(substituir).not.toHaveBeenCalled();
  });

  it('substitui o conjunto inteiro', async () => {
    const { service, substituir } = montar({ ativo: fatorFake({ status: 'active' }) });

    const codigos = await service.regenerarCodigos('u1', 'correta');

    expect(codigos).toHaveLength(10);
    expect(substituir).toHaveBeenCalledOnce();
  });

  it('sem fator ativo não gera código nenhum', async () => {
    const { service, substituir } = montar({});

    await expect(service.regenerarCodigos('u1', 'correta')).rejects.toMatchObject({
      motivo: 'nao-habilitado',
    });
    expect(substituir).not.toHaveBeenCalled();
  });
});

describe('removerFator', () => {
  it('limpa tudo sem pedir senha — é o caminho administrativo', async () => {
    const { service, removerFatores, removerCodigos, removerDesafios } = montar({});

    await expect(service.removerFator('u1', 'admin-1')).resolves.toBe(true);
    expect(removerFatores).toHaveBeenCalledWith('u1');
    expect(removerCodigos).toHaveBeenCalledWith('u1');
    expect(removerDesafios).toHaveBeenCalledWith('u1');
  });
});

describe('erros de domínio', () => {
  it('carrega o motivo', () => {
    expect(new ErroDeMfa('nao-habilitado').motivo).toBe('nao-habilitado');
  });
});
