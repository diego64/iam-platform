/**
 * Cobre os metadados do servidor de autorização: composição das URLs, o grant desligado
 * saindo da lista e o cache que evita uma ida ao banco por requisição de descoberta.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarMetadataService } from '../../../../src/modules/oauth/services/metadata.service.js';

const BASE = {
  emissor: 'https://iam.example.com',
  urlBase: 'https://iam.example.com',
  passwordGrantHabilitado: true,
};

describe('criarMetadataService', () => {
  it('monta o documento da RFC 8414', async () => {
    const service = criarMetadataService({
      ...BASE,
      listarEscopos: () => Promise.resolve(['orders:read']),
    });

    await expect(service.obter()).resolves.toEqual({
      issuer: 'https://iam.example.com',
      token_endpoint: 'https://iam.example.com/oauth/token',
      jwks_uri: 'https://iam.example.com/.well-known/jwks.json',
      grant_types_supported: ['client_credentials', 'password', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      response_types_supported: [],
      scopes_supported: ['orders:read'],
    });
  });

  it('omite o password grant quando ele está desligado', async () => {
    // Anunciar um grant que responde unsupported_grant_type mandaria o cliente integrar
    // com um caminho morto.
    const service = criarMetadataService({
      ...BASE,
      passwordGrantHabilitado: false,
      listarEscopos: () => Promise.resolve([]),
    });

    const documento = await service.obter();

    expect(documento.grant_types_supported).toEqual(['client_credentials', 'refresh_token']);
  });

  it('serve do cache dentro da janela e relê depois dela', async () => {
    const listarEscopos = vi.fn(() => Promise.resolve(['orders:read']));
    let instante = 1_000;
    const service = criarMetadataService({
      ...BASE,
      listarEscopos,
      cacheTtlMs: 5_000,
      agora: () => instante,
    });

    await service.obter();
    await service.obter();
    expect(listarEscopos).toHaveBeenCalledOnce();

    instante += 5_001;
    await service.obter();
    expect(listarEscopos).toHaveBeenCalledTimes(2);
  });
});
