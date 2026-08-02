/**
 * Responsabilidade: adaptar as rotas administrativas de chaves ao serviço de rotação —
 * extrair entrada, chamar o domínio e traduzir `ErroDeRotacao` para RFC 7807.
 * Regras:
 *  - A autorização NÃO acontece aqui: é o guard no preHandler da rota. O controller assume
 *    a requisição já autorizada.
 *  - A tradução de erro é explícita (não depende do handler global), para o mesmo contrato
 *    valer num app de teste isolado.
 *  - Nenhuma resposta carrega material de chave: só o que o DTO de metadados expõe.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { montarProblema } from '../../../shared/errors/problem-json.js';
import { idAutenticado } from '../../auth/middleware/verify-access-token.js';
import { ErroDeRotacao } from '../errors/rotation.errors.js';
import { chaveParaDTO } from '../dto/keys-admin.dto.js';
import type { KeyRotationService } from '../services/key-rotation.service.js';
import type { RepositorioJwks } from '../repositories/jwks.repository.js';
import type {
  KidParams,
  ListarChavesQuery,
  RevogarBody,
  RotacionarBody,
} from '../schemas/keys-admin.schema.js';

const TIPO_PROBLEM_JSON = 'application/problem+json';

export interface DependenciasDoControllerDeChaves {
  readonly rotacao: KeyRotationService;
  readonly repo: RepositorioJwks;
  /** Relógio injetável para teste; default `Date.now`. */
  readonly agora?: () => number;
}

export interface ControllerDeChaves {
  listar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  preparar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  rotacionar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
  revogar(req: FastifyRequest, resp: FastifyReply): Promise<void>;
}

/** Mapeia o código do erro de domínio para status + problem+json. */
function responderErro(erro: ErroDeRotacao, resposta: FastifyReply): void {
  const [status, slug, titulo, detalhe] = ((): [number, string, string, string | undefined] => {
    switch (erro.codigo) {
      case 'chave-nao-encontrada':
        return [404, 'key-not-found', 'Chave não encontrada', undefined];
      case 'sem-chave-proxima':
        return [
          409,
          'no-next-key',
          'Nenhuma chave pré-publicada',
          'Prepare a próxima chave antes de rotacionar',
        ];
      case 'chave-proxima-recente':
        return [
          409,
          'next-key-too-fresh',
          'Chave pré-publicada recente demais',
          // O instante é o que o operador precisa: sem ele, resta tentar de novo às cegas.
          `Rotação liberada a partir de ${erro.rotacionavelEm?.toISOString() ?? 'instante desconhecido'}`,
        ];
      case 'rotacao-em-andamento':
        return [409, 'rotation-in-progress', 'Rotação em andamento', undefined];
      case 'chave-ja-revogada':
        return [409, 'key-already-revoked', 'Chave já revogada', undefined];
    }
  })();

  void resposta
    .status(status)
    .type(TIPO_PROBLEM_JSON)
    .send(montarProblema(slug, titulo, status, detalhe));
}

export function criarControllerDeChaves(
  deps: DependenciasDoControllerDeChaves,
): ControllerDeChaves {
  const agora = deps.agora ?? Date.now;

  return {
    async listar(req, resp): Promise<void> {
      const { status } = req.query as ListarChavesQuery;
      const chaves = await deps.repo.listarMetadados(status === undefined ? {} : { status });
      const instante = agora();
      await resp.send({
        items: chaves.map((c) => chaveParaDTO(c, instante)),
        total: chaves.length,
      });
    },

    async preparar(req, resp): Promise<void> {
      const preparada = await deps.rotacao.prepararProxima(idAutenticado(req) ?? undefined);
      // 201 só quando houve criação: repetir o preparo é idempotente, não um recurso novo.
      await resp.status(preparada.criada ? 201 : 200).send({
        kid: preparada.kid,
        status: 'next',
        created_at: preparada.criadaEm.toISOString(),
        rotatable_at: preparada.rotacionavelEm.toISOString(),
      });
    },

    async rotacionar(req, resp): Promise<void> {
      const { motivo } = req.body as RotacionarBody;
      try {
        const resultado = await deps.rotacao.rotacionar({
          motivo: 'manual',
          ator: idAutenticado(req) ?? undefined,
        });
        req.log.info({ motivo: motivo ?? null }, 'jwks.rotate: rotação manual concluída');
        await resp.send({
          previous_kid: resultado.kidAnterior,
          active_kid: resultado.kidAtivo,
          next_kid: resultado.kidProximo,
          verifiable_until: resultado.verificavelAte?.toISOString() ?? null,
        });
      } catch (erro) {
        if (erro instanceof ErroDeRotacao) {
          responderErro(erro, resp);
          return;
        }
        throw erro;
      }
    },

    async revogar(req, resp): Promise<void> {
      const { kid } = req.params as KidParams;
      const { motivo } = req.body as RevogarBody;
      try {
        const resultado = await deps.rotacao.revogar(kid, motivo, idAutenticado(req) ?? undefined);
        await resp.send({
          revoked_kid: resultado.kidRevogado,
          active_kid: resultado.kidAtivo,
          tokens_invalidated: resultado.tokensInvalidados,
        });
      } catch (erro) {
        if (erro instanceof ErroDeRotacao) {
          responderErro(erro, resp);
          return;
        }
        throw erro;
      }
    },
  };
}
