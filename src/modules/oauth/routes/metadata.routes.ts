/**
 * Responsabilidade: registrar `GET /.well-known/oauth-authorization-server` (RFC 8414).
 * Regras:
 *  - Fica **fora** do escopo encapsulado do endpoint de token: é rota pública de JSON, sem
 *    formulário e sem o formato de erro de OAuth. Dentro do escopo, ela herdaria a exigência
 *    de `content-type` de formulário e passaria a recusar todo GET.
 *  - Cache público: o documento é a mesma resposta para todo mundo e muda em escala de dias.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { metadadosDoServidor } from '../schemas/oauth.schema.js';
import type { MetadataService } from '../services/metadata.service.js';

export interface DependenciasDasRotasDeMetadados {
  readonly metadataService: MetadataService;
}

export function registrarRotasDeMetadados(
  app: FastifyInstance,
  deps: DependenciasDasRotasDeMetadados,
): void {
  const tipado = app.withTypeProvider<ZodTypeProvider>();

  tipado.get(
    '/.well-known/oauth-authorization-server',
    {
      schema: {
        tags: ['oauth'],
        summary: 'Metadados do servidor de autorização (RFC 8414)',
        response: { 200: metadadosDoServidor },
      },
    },
    async (_requisicao, resposta) => {
      const documento = await deps.metadataService.obter();
      await resposta
        .header('cache-control', 'public, max-age=3600')
        .status(200)
        // O serializador do Zod pede arrays mutáveis; o documento em cache é imutável de
        // propósito, então a cópia acontece aqui, na borda.
        .send({
          ...documento,
          grant_types_supported: [...documento.grant_types_supported],
          token_endpoint_auth_methods_supported: [
            ...documento.token_endpoint_auth_methods_supported,
          ],
          response_types_supported: [...documento.response_types_supported],
          scopes_supported: [...documento.scopes_supported],
        });
    },
  );
}
