/**
 * Cobre o OAuthService: autenticação do cliente, trava por grant e o grant
 * `client_credentials` — escopo concedido, TTL do cliente e ausência de refresh token.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  criarOAuthService,
  type OAuthService,
  type PedidoDeToken,
} from '../../../../src/modules/oauth/services/oauth.service.js';
import type { ClienteAutenticado } from '../../../../src/modules/api-clients/types/api-client.types.js';
import type { TokenEmitido } from '../../../../src/modules/auth/services/token.service.js';
import type {
  Credenciais,
  OpcoesDeLogin,
} from '../../../../src/modules/auth/services/auth.service.js';
import type { ParDeTokens } from '../../../../src/modules/auth/types/auth.types.js';
import type { OpcoesDeRotacao } from '../../../../src/modules/refresh-token/services/refresh-token.service.js';
import { ErroDeRefreshInvalido } from '../../../../src/modules/refresh-token/errors/refresh-token-error.js';
import { ErroDeAutenticacao } from '../../../../src/modules/auth/errors/auth-error.js';

const CREDENCIAL = { clientId: 'cli_abc', secret: 's3gr3d0' };

function clienteFake(sobrescritas: Partial<ClienteAutenticado> = {}): ClienteAutenticado {
  return {
    id: 'uuid-1',
    clientId: 'cli_abc',
    escopos: ['orders:read', 'orders:write'],
    grantTypes: ['client_credentials'],
    accessTokenTtlSegundos: null,
    ...sobrescritas,
  };
}

interface Fakes {
  service: OAuthService;
  autenticar: ReturnType<typeof vi.fn>;
  emitir: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  rotacionar: ReturnType<typeof vi.fn>;
}

function montar(
  cliente: ClienteAutenticado | null = clienteFake(),
  opcoes: {
    passwordGrantHabilitado?: boolean;
    permissoesDoUsuario?: string[];
    escopoOriginal?: string | null;
  } = {},
): Fakes {
  const autenticar = vi.fn(() => Promise.resolve(cliente));
  const emitir = vi.fn<() => Promise<TokenEmitido>>(() =>
    Promise.resolve({ token: 'jwt-cli', jti: 'j1', expiraEm: new Date(), ttlSegundos: 900 }),
  );
  // Reproduz o que o login faz com o recorte: chama a função com as permissões efetivas do
  // usuário e emite o token com o que ela devolver.
  const login = vi.fn(
    (_credenciais: Credenciais, opcoesDeLogin?: OpcoesDeLogin): Promise<ParDeTokens> => {
      opcoesDeLogin?.restringirAutoridade?.(opcoes.permissoesDoUsuario ?? ['*']);
      return Promise.resolve({
        accessToken: 'jwt-usuario',
        refreshToken: 'refresh-opaco',
        expiraEmSegundos: 900,
      });
    },
  );

  const rotacionar = vi.fn(
    (_token: string, opcoesDeRotacao?: OpcoesDeRotacao): Promise<ParDeTokens> => {
      opcoesDeRotacao?.restringirAutoridade?.({
        permissoesDoUsuario: opcoes.permissoesDoUsuario ?? ['*'],
        escopoOriginal: opcoes.escopoOriginal ?? null,
      });
      return Promise.resolve({
        accessToken: 'jwt-renovado',
        refreshToken: 'refresh-sucessor',
        expiraEmSegundos: 900,
      });
    },
  );

  return {
    service: criarOAuthService({
      clientAuth: { autenticar },
      tokenService: { emitir },
      authService: { login },
      refreshTokenService: { rotacionar },
      passwordGrantHabilitado: opcoes.passwordGrantHabilitado ?? true,
    }),
    autenticar,
    emitir,
    login,
    rotacionar,
  };
}

function pedido(sobrescritas: Partial<PedidoDeToken> = {}): PedidoDeToken {
  return { grantType: 'client_credentials', credencial: CREDENCIAL, ...sobrescritas };
}

describe('autenticação do cliente', () => {
  it('cliente recusado vira invalid_client', async () => {
    const { service } = montar(null);

    await expect(service.emitir(pedido())).rejects.toMatchObject({
      codigo: 'invalid_client',
      status: 401,
    });
  });

  it('grant fora dos grant_types do cliente vira unauthorized_client', async () => {
    const { service } = montar(clienteFake({ grantTypes: ['client_credentials'] }));

    await expect(service.emitir(pedido({ grantType: 'password' }))).rejects.toMatchObject({
      codigo: 'unauthorized_client',
    });
  });

  it('grant desconhecido vira unsupported_grant_type', async () => {
    const { service } = montar();

    await expect(service.emitir(pedido({ grantType: 'authorization_code' }))).rejects.toMatchObject(
      { codigo: 'unsupported_grant_type' },
    );
  });
});

describe('grant client_credentials', () => {
  it('emite token de cliente sem refresh token', async () => {
    const { service, emitir } = montar();

    const concedido = await service.emitir(pedido());

    expect(concedido).toEqual({
      accessToken: 'jwt-cli',
      tokenType: 'Bearer',
      expiresIn: 900,
      scope: 'orders:read orders:write',
    });
    expect(concedido.refreshToken).toBeUndefined();
    expect(emitir).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: 'cli_abc',
        subType: 'client',
        clientId: 'cli_abc',
        roles: [],
        permissions: ['orders:read', 'orders:write'],
      }),
      undefined,
    );
  });

  it('recorta ao escopo solicitado', async () => {
    const { service } = montar();

    const concedido = await service.emitir(pedido({ escoposSolicitados: ['orders:read'] }));

    expect(concedido.scope).toBe('orders:read');
  });

  it('escopo fora do cliente vira invalid_scope', async () => {
    const { service } = montar();

    await expect(
      service.emitir(pedido({ escoposSolicitados: ['users:delete'] })),
    ).rejects.toMatchObject({ codigo: 'invalid_scope' });
  });

  it('o TTL do cliente sobrepõe o global', async () => {
    const { service, emitir } = montar(clienteFake({ accessTokenTtlSegundos: 120 }));

    await service.emitir(pedido());

    expect(emitir).toHaveBeenCalledWith(expect.anything(), { ttlSegundos: 120 });
  });
});

describe('grant password', () => {
  const CLIENTE_COM_SENHA = clienteFake({ grantTypes: ['password'], escopos: ['orders:read'] });

  function pedidoDeSenha(sobrescritas: Partial<PedidoDeToken> = {}): PedidoDeToken {
    return pedido({
      grantType: 'password',
      username: 'a@iam.local',
      password: 'S3nh@Forte!',
      ...sobrescritas,
    });
  }

  it('emite o par de tokens delegando ao login', async () => {
    const { service, login } = montar(CLIENTE_COM_SENHA);

    const concedido = await service.emitir(pedidoDeSenha());

    expect(concedido).toEqual({
      accessToken: 'jwt-usuario',
      tokenType: 'Bearer',
      expiresIn: 900,
      scope: 'orders:read',
      refreshToken: 'refresh-opaco',
    });
    expect(login).toHaveBeenCalledWith(
      { email: 'a@iam.local', senha: 'S3nh@Forte!' },
      expect.objectContaining({ clientId: 'cli_abc' }),
    );
  });

  it('rebaixa um superadmin ao escopo do cliente', async () => {
    // O usuário tem o curinga; o cliente tem um escopo. O token sai com um escopo.
    const { service } = montar(CLIENTE_COM_SENHA, { permissoesDoUsuario: ['*'] });

    const concedido = await service.emitir(pedidoDeSenha());

    expect(concedido.scope).toBe('orders:read');
  });

  it('falha de credencial vira invalid_grant', async () => {
    const { service, login } = montar(CLIENTE_COM_SENHA);
    login.mockRejectedValueOnce(new ErroDeAutenticacao('credencial-invalida'));

    await expect(service.emitir(pedidoDeSenha())).rejects.toMatchObject({
      codigo: 'invalid_grant',
    });
  });

  it('username ou password ausentes viram invalid_request', async () => {
    const { service } = montar(CLIENTE_COM_SENHA);

    await expect(service.emitir(pedidoDeSenha({ password: undefined }))).rejects.toMatchObject({
      codigo: 'invalid_request',
    });
  });

  it('com o interruptor desligado o grant deixa de existir', async () => {
    const { service, login } = montar(CLIENTE_COM_SENHA, { passwordGrantHabilitado: false });

    await expect(service.emitir(pedidoDeSenha())).rejects.toMatchObject({
      codigo: 'unsupported_grant_type',
    });
    expect(login).not.toHaveBeenCalled();
  });

  it('escopo fora do cliente vira invalid_scope, não invalid_grant', async () => {
    const { service } = montar(CLIENTE_COM_SENHA);

    await expect(
      service.emitir(pedidoDeSenha({ escoposSolicitados: ['users:delete'] })),
    ).rejects.toMatchObject({ codigo: 'invalid_scope' });
  });
});

describe('grant refresh_token', () => {
  const CLIENTE_COM_REFRESH = clienteFake({
    grantTypes: ['refresh_token'],
    escopos: ['orders:read', 'orders:write'],
  });

  function pedidoDeRefresh(sobrescritas: Partial<PedidoDeToken> = {}): PedidoDeToken {
    return pedido({ grantType: 'refresh_token', refreshToken: 'opaco-88', ...sobrescritas });
  }

  it('rotaciona e devolve o sucessor', async () => {
    const { service, rotacionar } = montar(CLIENTE_COM_REFRESH, {
      escopoOriginal: 'orders:read',
    });

    const concedido = await service.emitir(pedidoDeRefresh());

    expect(concedido).toEqual({
      accessToken: 'jwt-renovado',
      tokenType: 'Bearer',
      expiresIn: 900,
      scope: 'orders:read',
      refreshToken: 'refresh-sucessor',
    });
    expect(rotacionar).toHaveBeenCalledWith(
      'opaco-88',
      expect.objectContaining({ clientIdEsperado: 'cli_abc' }),
    );
  });

  it('a renovação não amplia o escopo concedido na emissão', async () => {
    const { service } = montar(CLIENTE_COM_REFRESH, { escopoOriginal: 'orders:read' });

    await expect(
      service.emitir(pedidoDeRefresh({ escoposSolicitados: ['orders:write'] })),
    ).rejects.toMatchObject({ codigo: 'invalid_scope' });
  });

  it('sem escopo gravado, o teto volta a ser o do cliente', async () => {
    const { service } = montar(CLIENTE_COM_REFRESH, { escopoOriginal: null });

    const concedido = await service.emitir(pedidoDeRefresh());

    expect(concedido.scope).toBe('orders:read orders:write');
  });

  it('qualquer falha da rotação vira invalid_grant', async () => {
    const { service, rotacionar } = montar(CLIENTE_COM_REFRESH);
    rotacionar.mockRejectedValueOnce(new ErroDeRefreshInvalido('cliente_divergente'));

    await expect(service.emitir(pedidoDeRefresh())).rejects.toMatchObject({
      codigo: 'invalid_grant',
    });
  });

  it('refresh_token ausente vira invalid_request', async () => {
    const { service } = montar(CLIENTE_COM_REFRESH);

    await expect(
      service.emitir(pedidoDeRefresh({ refreshToken: undefined })),
    ).rejects.toMatchObject({ codigo: 'invalid_request' });
  });
});
