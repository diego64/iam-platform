/**
 * Responsabilidade: adaptar as rotas de auth ao AuthService — extrair entrada, chamar o
 * domínio e traduzir `ErroDeAutenticacao` para RFC 7807.
 * Regras:
 *  - A tradução de erro é explícita aqui (não depende do handler global), para o mesmo
 *    contrato valer num app de teste isolado.
 *  - Falha de login responde sempre a mesma mensagem genérica (401 invalid-credentials).
 *  - Nenhuma resposta ecoa senha ou token além do que o contrato define.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeAutenticacao } from '../errors/auth-error.js';
import type { AuthService } from '../services/auth.service.js';
import type { LoginBody } from '../schemas/auth.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeAuth {
  readonly authService: AuthService;
}

export interface ControllerDeAuth {
  login(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  logout(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  eu(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

function recusarToken(resposta: FastifyReply): void {
  void resposta
    .status(401)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema('invalid-token', 'Token inválido', 401));
}

export function criarControllerDeAuth(deps: DependenciasDoControllerDeAuth): ControllerDeAuth {
  return {
    async login(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const { email, senha } = requisicao.body as LoginBody;
      const contexto = {
        ip: requisicao.ip,
        userAgent: requisicao.headers['user-agent'] ?? null,
      };
      try {
        const par = await deps.authService.login({ email, senha }, contexto);
        await resposta.status(200).send({
          access_token: par.accessToken,
          refresh_token: par.refreshToken,
          token_type: 'Bearer',
          expires_in: par.expiraEmSegundos,
        });
      } catch (erro) {
        if (erro instanceof ErroDeAutenticacao) {
          // Mensagem única para qualquer falha de credencial (sem enumeração).
          await resposta
            .status(401)
            .type(TIPO_PROBLEM_JSON)
            .send(montarProblema('invalid-credentials', 'Credenciais inválidas', 401));
          return;
        }
        throw erro;
      }
    },

    async logout(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const usuario = requisicao.usuario;
      const token = requisicao.tokenAtual;
      if (usuario === undefined || token === undefined) {
        recusarToken(resposta);
        return;
      }
      const { refresh_token } = requisicao.body as { refresh_token: string };
      await deps.authService.logout({
        jti: token.jti,
        userId: usuario.id,
        expiraEm: new Date(token.exp * 1000),
        refreshToken: refresh_token,
      });
      await resposta.status(204).send();
    },

    async eu(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const usuario = requisicao.usuario;
      if (usuario === undefined) {
        recusarToken(resposta);
        return;
      }
      const perfil = await deps.authService.perfil(usuario.id);
      if (perfil === null) {
        recusarToken(resposta);
        return;
      }
      await resposta.status(200).send(perfil);
    },
  };
}
