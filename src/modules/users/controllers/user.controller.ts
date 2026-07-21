/**
 * Responsabilidade: adaptar as rotas de usuário ao `UserService` — autorizar, extrair
 * entrada, chamar o domínio e traduzir `ErroDeUsuario` para RFC 7807.
 * Regras:
 *  - A autorização roda antes de tudo: sem token ⇒ 401, sem papel admin ⇒ 403.
 *  - A tradução de erro é explícita aqui (não depende do handler global): mantém o mesmo
 *    contrato quando as rotas sobem num app de teste isolado.
 *  - Nenhuma resposta ecoa a senha; o DTO nunca inclui `password_hash`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { paraDTO } from '../dto/user.dto.js';
import { ErroDeUsuario } from '../errors/user-error.js';
import type { AutorizadorAdmin } from '../interfaces/autorizador-admin.port.js';
import { medidorDeUsuariosNulo, type MedidorDeUsuarios } from '../metrics/users.metrics.js';
import type { UserService } from '../services/user.service.js';
import type {
  AtualizarUsuarioBody,
  CriarUsuarioBody,
  IdParams,
  ListarUsuariosQuery,
} from '../schemas/user.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoController {
  readonly userService: UserService;
  readonly autorizador: AutorizadorAdmin;
  /** Contadores de operação. Ausente ⇒ medidor nulo (testes/app sem telemetria). */
  readonly medidor?: MedidorDeUsuarios;
}

export interface ControllerDeUsuario {
  criar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  listar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  obter(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  atualizar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  bloquear(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  desbloquear(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  remover(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

/** Mapeia o código do erro de domínio para status + problem+json. */
function responderErro(erro: ErroDeUsuario, resposta: FastifyReply): void {
  switch (erro.codigo) {
    case 'email-conflito':
      void resposta
        .status(409)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('email-conflict', 'E-mail já cadastrado', 409));
      return;
    case 'nao-encontrado':
      void resposta
        .status(404)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('user-not-found', 'Usuário não encontrado', 404));
      return;
    case 'politica':
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('validation-error', 'Senha inválida', 400, erro.detalhe));
      return;
  }
}

export function criarControllerDeUsuario(deps: DependenciasDoController): ControllerDeUsuario {
  const { userService, autorizador } = deps;
  const medidor = deps.medidor ?? medidorDeUsuariosNulo();

  /**
   * Autoriza e executa. Recusa vira 401/403; `ErroDeUsuario` vira problem+json; qualquer
   * outro erro sobe ao handler global. Devolve `true` se a ação chegou a rodar (autorizada
   * e sem `ErroDeUsuario`), para o chamador contar a métrica só do caminho efetivo.
   */
  async function comAutorizacao(
    requisicao: FastifyRequest,
    resposta: FastifyReply,
    acao: (adminId: string) => Promise<void>,
  ): Promise<boolean> {
    const autz = autorizador(requisicao);
    if (!autz.ok) {
      const [status, slug, titulo] =
        autz.motivo === 'sem-token'
          ? ([401, 'invalid-token', 'Token inválido'] as const)
          : ([403, 'forbidden', 'Acesso negado'] as const);
      void resposta
        .status(status)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema(slug, titulo, status));
      return false;
    }

    try {
      await acao(autz.adminId);
      return true;
    } catch (erro) {
      if (erro instanceof ErroDeUsuario) {
        responderErro(erro, resposta);
        return false;
      }
      throw erro;
    }
  }

  return {
    async criar(requisicao, resposta): Promise<void> {
      const executou = await comAutorizacao(requisicao, resposta, async () => {
        const { email, senha } = requisicao.body as CriarUsuarioBody;
        const usuario = await userService.criar({ email, senha });
        void resposta.status(201).send(paraDTO(usuario));
      });
      if (executou) medidor.contarCriacao();
    },

    async listar(requisicao, resposta): Promise<void> {
      await comAutorizacao(requisicao, resposta, async () => {
        const { limit, offset, status } = requisicao.query as ListarUsuariosQuery;
        const { items, total } = await userService.listar({
          limite: limit,
          offset,
          ...(status === undefined ? {} : { status }),
        });
        void resposta.status(200).send({ items: items.map(paraDTO), total, limit, offset });
      });
    },

    async obter(requisicao, resposta): Promise<void> {
      await comAutorizacao(requisicao, resposta, async () => {
        const { id } = requisicao.params as IdParams;
        const usuario = await userService.obter(id);
        void resposta.status(200).send(paraDTO(usuario));
      });
    },

    async atualizar(requisicao, resposta): Promise<void> {
      await comAutorizacao(requisicao, resposta, async () => {
        const { id } = requisicao.params as IdParams;
        const { email } = requisicao.body as AtualizarUsuarioBody;
        const usuario = await userService.atualizarEmail(id, email);
        void resposta.status(200).send(paraDTO(usuario));
      });
    },

    async bloquear(requisicao, resposta): Promise<void> {
      const { id } = requisicao.params as IdParams;
      const executou = await comAutorizacao(requisicao, resposta, async () => {
        const usuario = await userService.bloquear(id);
        void resposta.status(200).send({ id: usuario.id, status: usuario.status });
      });
      medidor.contarBloqueio(executou ? 'ok' : 'erro');
    },

    async desbloquear(requisicao, resposta): Promise<void> {
      await comAutorizacao(requisicao, resposta, async () => {
        const { id } = requisicao.params as IdParams;
        const usuario = await userService.desbloquear(id);
        void resposta.status(200).send({ id: usuario.id, status: usuario.status });
      });
    },

    async remover(requisicao, resposta): Promise<void> {
      const executou = await comAutorizacao(requisicao, resposta, async () => {
        const { id } = requisicao.params as IdParams;
        await userService.remover(id);
        void resposta.status(204).send();
      });
      if (executou) medidor.contarRemocao();
    },
  };
}
