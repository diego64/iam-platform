/**
 * Responsabilidade: adaptar as rotas de senha ao PasswordService — extrair entrada,
 * chamar o domínio, e traduzir `ErroDeSenha` para RFC 7807.
 * Regras:
 *  - A tradução de erro é explícita aqui (não depende do handler global): mantém o mesmo
 *    contrato quando as rotas sobem num app de teste isolado.
 *  - `forgot` responde **sempre 202**, mesmo corpo, exista o e-mail ou não.
 *  - Nenhuma resposta ecoa a senha; o `detalhe` da política é o motivo, nunca o valor.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { POLITICA } from '../validators/politica.js';
import { ErroDeSenha } from '../errors/password-error.js';
import type { PasswordService } from '../services/password.service.js';
import type { AutenticarUsuario } from '../interfaces/auth.port.js';
import type {
  EsqueciSenhaBody,
  ResetSenhaBody,
  TrocarSenhaBody,
} from '../schemas/password.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoController {
  readonly passwordService: PasswordService;
  readonly autenticar: AutenticarUsuario;
  /**
   * Recebe o trabalho de fundo do `forgot` (gerar/gravar token, notificar), que roda
   * depois da resposta. Opcional: existe para o teste conseguir aguardar esse trabalho;
   * em produção fica ausente e o trabalho é fire-and-forget mesmo.
   */
  readonly aoAgendarTrabalho?: (trabalho: Promise<void>) => void;
}

export interface ControllerDeSenha {
  trocar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  esqueci(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  reset(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  politica(requisicao: FastifyRequest, resposta: FastifyReply): void;
}

/** Mapeia o código do erro de domínio para status + problem+json. */
function responderErro(erro: ErroDeSenha, resposta: FastifyReply): void {
  switch (erro.codigo) {
    case 'credencial-invalida':
      void resposta
        .status(401)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('invalid-credentials', 'Credenciais inválidas', 401));
      return;
    case 'politica':
      // `detalhe` já vem como a mensagem pronta e sanitizada do domínio — repassa direto.
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('validation-error', 'Senha inválida', 400, erro.detalhe));
      return;
    case 'reuso':
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('password-reuse', 'Senha já utilizada', 400));
      return;
    case 'token-invalido':
      void resposta
        .status(400)
        .type(TIPO_PROBLEM_JSON)
        .send(montarProblema('invalid-reset-token', 'Token de reset inválido', 400));
      return;
  }
}

/** Executa a ação e, em `ErroDeSenha`, responde problem+json; outros erros sobem ao handler global. */
async function comTratamento(resposta: FastifyReply, acao: () => Promise<void>): Promise<void> {
  try {
    await acao();
  } catch (erro) {
    if (erro instanceof ErroDeSenha) {
      responderErro(erro, resposta);
      return;
    }
    throw erro;
  }
}

export function criarControllerDeSenha(deps: DependenciasDoController): ControllerDeSenha {
  const { passwordService, autenticar, aoAgendarTrabalho } = deps;

  return {
    async trocar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const userId = autenticar(requisicao);
      if (userId === null) {
        void resposta
          .status(401)
          .type(TIPO_PROBLEM_JSON)
          .send(montarProblema('invalid-token', 'Token inválido', 401));
        return;
      }

      const { senha_atual, senha_nova } = requisicao.body as TrocarSenhaBody;
      await comTratamento(resposta, async () => {
        await passwordService.trocar({ userId, senhaAtual: senha_atual, senhaNova: senha_nova });
        void resposta.status(204).send();
      });
    },

    esqueci(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const { email } = requisicao.body as EsqueciSenhaBody;

      // Responde ANTES de tocar no banco: o tempo de resposta é constante e não depende de
      // a conta existir. Gerar/gravar o token e notificar rodam depois, sem serem
      // aguardados aqui — forgot nunca surfaça resultado (sempre 202, mesmo corpo), então
      // nada se perde ao não esperar. A falha do trabalho de fundo vira log, não erro HTTP.
      const trabalho = passwordService
        .solicitarReset({ email, ipOrigem: requisicao.ip })
        .catch((erro: unknown) => {
          requisicao.log.warn({ err: erro }, 'password.forgot.trabalho_falhou');
        });
      aoAgendarTrabalho?.(trabalho);

      void resposta.status(202).send({
        message: 'Se o e-mail existir, enviaremos instruções de recuperação.',
      });
      return Promise.resolve();
    },

    async reset(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void> {
      const { token, senha_nova } = requisicao.body as ResetSenhaBody;
      await comTratamento(resposta, async () => {
        await passwordService.confirmarReset({ token, senhaNova: senha_nova });
        void resposta.status(204).send();
      });
    },

    politica(_requisicao: FastifyRequest, resposta: FastifyReply): void {
      void resposta.status(200).send({
        min_length: POLITICA.comprimentoMinimo,
        max_length: POLITICA.comprimentoMaximo,
        required_classes: POLITICA.classesExigidas,
        classes: POLITICA.classes,
        blocks_common_passwords: true,
      });
    },
  };
}
