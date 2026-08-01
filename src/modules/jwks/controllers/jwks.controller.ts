/**
 * Responsabilidade: montar a resposta do endpoint JWKS a partir do serviço de chaves.
 * Regras: recebe o serviço por injeção; não conhece banco nem Fastify. Devolve apenas
 * material público (o serviço já garante isso).
 */
import type { JwksService } from '../services/jwks.service.js';
import type { JwksResponse } from '../schemas/jwks.schema.js';

export interface DependenciasDoControllerJwks {
  readonly jwks: JwksService;
}

export function criarControllerDeJwks(deps: DependenciasDoControllerJwks): {
  publicar(): Promise<JwksResponse>;
} {
  return {
    async publicar(): Promise<JwksResponse> {
      return deps.jwks.obterConjuntoPublico();
    },
  };
}
