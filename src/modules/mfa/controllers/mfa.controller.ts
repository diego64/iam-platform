/**
 * Responsabilidade: adaptar as rotas de MFA aos serviços e traduzir `ErroDeMfa` para RFC 7807.
 * Regras:
 *  - A tradução é explícita aqui (não depende do handler global), para o mesmo contrato valer
 *    num app de teste isolado.
 *  - `desafio-invalido` e a falha de credencial respondem sempre a mesma coisa: quem sonda
 *    desafios não pode aprender nada com a diferença entre "expirou" e "código errado".
 *  - Nenhuma resposta ecoa segredo, código ou token além do que o contrato define, e o log da
 *    borda registra o evento sem o valor.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { ErroDeAutenticacao } from '../../auth/errors/auth-error.js';
import { ErroDeMfa, type MotivoDeErroDeMfa } from '../errors/mfa-error.js';
import type { MfaService } from '../services/mfa.service.js';
import type { AuthService } from '../../auth/services/auth.service.js';
import type {
  CadastroBody,
  ConfirmacaoBody,
  StepUpBody,
  VerificacaoBody,
} from '../schemas/mfa.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

/** Cada motivo tem um status e um título fixos. Nada aqui varia com a entrada. */
const RESPOSTA_POR_MOTIVO: Readonly<
  Record<MotivoDeErroDeMfa, { status: number; tipo: string; titulo: string }>
> = {
  'ja-habilitado': {
    status: 409,
    tipo: 'mfa-already-enabled',
    titulo: 'Já existe um segundo fator ativo',
  },
  'cadastro-nao-encontrado': {
    status: 404,
    tipo: 'mfa-enrollment-not-found',
    titulo: 'Nenhum cadastro pendente',
  },
  'codigo-invalido': { status: 400, tipo: 'mfa-invalid-code', titulo: 'Código inválido' },
  'nao-habilitado': {
    status: 404,
    tipo: 'mfa-not-enabled',
    titulo: 'Segundo fator não habilitado',
  },
  'desafio-invalido': {
    status: 400,
    tipo: 'mfa-invalid-challenge',
    titulo: 'Desafio inválido ou expirado',
  },
  'credencial-invalida': {
    status: 401,
    tipo: 'invalid-credentials',
    titulo: 'Credenciais inválidas',
  },
  'usuario-nao-encontrado': {
    status: 404,
    tipo: 'user-not-found',
    titulo: 'Usuário não encontrado',
  },
};

export interface DependenciasDoControllerDeMfa {
  readonly mfaService: MfaService;
  /** A conclusão do desafio emite tokens, e a emissão vive num lugar só: no auth. */
  readonly authService: Pick<AuthService, 'concluirDesafio'>;
  /** Id do usuário autenticado na requisição. */
  readonly autenticar: (requisicao: FastifyRequest) => string | null;
}

export interface ControllerDeMfa {
  iniciar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  confirmar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  estado(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  desativar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  regenerar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
  verificar(requisicao: FastifyRequest, resposta: FastifyReply): Promise<void>;
}

export function criarControllerDeMfa(deps: DependenciasDoControllerDeMfa): ControllerDeMfa {
  async function responderErro(resposta: FastifyReply, motivo: MotivoDeErroDeMfa): Promise<void> {
    const { status, tipo, titulo } = RESPOSTA_POR_MOTIVO[motivo];
    await resposta
      .status(status)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema(tipo, titulo, status));
  }

  async function semToken(resposta: FastifyReply): Promise<void> {
    await resposta
      .status(401)
      .type(TIPO_PROBLEM_JSON)
      .send(montarProblema('invalid-token', 'Token inválido', 401));
  }

  /** Roda a operação com o usuário autenticado, traduzindo o erro de domínio. */
  async function comUsuario(
    requisicao: FastifyRequest,
    resposta: FastifyReply,
    operacao: (userId: string) => Promise<void>,
  ): Promise<void> {
    const userId = deps.autenticar(requisicao);
    if (userId === null) {
      await semToken(resposta);
      return;
    }
    try {
      await operacao(userId);
    } catch (erro) {
      if (erro instanceof ErroDeMfa) {
        requisicao.log.info({ evento: 'mfa.recusado', motivo: erro.motivo }, 'operação recusada');
        await responderErro(resposta, erro.motivo);
        return;
      }
      throw erro;
    }
  }

  return {
    async iniciar(requisicao, resposta): Promise<void> {
      const { label } = requisicao.body as CadastroBody;
      await comUsuario(requisicao, resposta, async (userId) => {
        const iniciado = await deps.mfaService.iniciarCadastro(userId, label ?? null);
        await resposta
          .status(201)
          .send({ secret: iniciado.segredoBase32, otpauth_uri: iniciado.uriOtpauth });
      });
    },

    async confirmar(requisicao, resposta): Promise<void> {
      const { code } = requisicao.body as ConfirmacaoBody;
      await comUsuario(requisicao, resposta, async (userId) => {
        const confirmado = await deps.mfaService.confirmarCadastro(userId, code);
        requisicao.log.info({ evento: 'mfa.ativado' }, 'segundo fator ativado');
        await resposta.status(200).send({
          status: 'active',
          confirmed_at: confirmado.confirmadoEm.toISOString(),
          recovery_codes: confirmado.codigosDeRecuperacao,
        });
      });
    },

    async estado(requisicao, resposta): Promise<void> {
      await comUsuario(requisicao, resposta, async (userId) => {
        const estado = await deps.mfaService.estado(userId);
        await resposta.status(200).send({
          enabled: estado.habilitado,
          status: estado.status,
          type: estado.tipo,
          confirmed_at: estado.confirmadoEm?.toISOString() ?? null,
          last_used_at: estado.ultimoUsoEm?.toISOString() ?? null,
          recovery_codes_remaining: estado.codigosDeRecuperacaoRestantes,
        });
      });
    },

    async desativar(requisicao, resposta): Promise<void> {
      const { senha } = requisicao.body as StepUpBody;
      await comUsuario(requisicao, resposta, async (userId) => {
        await deps.mfaService.desativar(userId, senha);
        requisicao.log.info({ evento: 'mfa.desativado' }, 'segundo fator desativado');
        await resposta.status(204).send();
      });
    },

    async regenerar(requisicao, resposta): Promise<void> {
      const { senha } = requisicao.body as StepUpBody;
      await comUsuario(requisicao, resposta, async (userId) => {
        const codigos = await deps.mfaService.regenerarCodigos(userId, senha);
        await resposta.status(200).send({ recovery_codes: codigos });
      });
    },

    async verificar(requisicao, resposta): Promise<void> {
      const corpo = requisicao.body as VerificacaoBody;
      try {
        const par = await deps.authService.concluirDesafio(corpo.mfa_token, {
          codigo: corpo.code,
          codigoDeRecuperacao: corpo.recovery_code,
        });
        requisicao.log.info({ evento: 'mfa.verificado' }, 'segundo fator verificado');
        await resposta.status(200).send({
          access_token: par.accessToken,
          refresh_token: par.refreshToken,
          token_type: 'Bearer',
          expires_in: par.expiraEmSegundos,
        });
      } catch (erro) {
        if (erro instanceof ErroDeAutenticacao) {
          // Uma resposta só para desafio ausente, expirado, esgotado e código errado — e
          // também para a conta que foi bloqueada entre a senha e o segundo fator.
          requisicao.log.warn(
            { evento: 'mfa.recusado', codigo: erro.codigo },
            'verificação recusada',
          );
          await responderErro(resposta, 'desafio-invalido');
          return;
        }
        throw erro;
      }
    },
  };
}
