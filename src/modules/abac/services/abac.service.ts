/**
 * Responsabilidade: orquestrar a administração de políticas.
 * Consumido por: o controller do ABAC.
 * Regras:
 *  - Política `is_system` (seed da 0005) não é editada nem removida: `ErroDeAbac('politica-imutavel')`.
 *  - Toda escrita invalida o cache do PDP no processo — sem isso, uma política recém-criada
 *    só passaria a valer no fim do TTL, e quem acabou de criar um `deny` esperaria que ele
 *    já estivesse valendo.
 *  - A gramática da condição é validada por Zod na borda; aqui a revalidação é só a de
 *    **forma** (profundidade/nós), com o validador que não conhece Zod — o domínio não
 *    importa Zod (CLAUDE.md). Vale como rede: nada entra na tabela fora dos limites, mesmo
 *    que um chamador futuro pule a borda HTTP.
 *  - Nenhum banco nem Fastify aqui: repositório e motor entram por injeção.
 */
import { ErroDeAbac } from '../errors/abac.errors.js';
import type {
  DadosDePolitica,
  FiltroDePolitica,
  RepositorioDePolitica,
} from '../repositories/policy.repository.js';
import type { MotorDePoliticas } from './policy-engine.js';
import type { Condicao, Efeito, Politica } from '../types/abac.types.js';
import { condicaoDentroDosLimites } from '../validators/condition-limits.js';

export interface Pagina<T> {
  readonly items: T[];
  readonly total: number;
}

/** Campos que um PATCH pode tocar — todos opcionais; o serviço resolve contra a linha atual. */
export interface PatchDePolitica {
  readonly name?: string;
  readonly description?: string | null;
  readonly effect?: Efeito;
  readonly resourceType?: string;
  readonly action?: string;
  readonly condition?: Condicao;
  readonly priority?: number;
  readonly enabled?: boolean;
}

export interface DependenciasDoAbacService {
  readonly politicas: RepositorioDePolitica;
  readonly motor: Pick<MotorDePoliticas, 'invalidar'>;
}

export interface AbacService {
  criarPolitica(dados: DadosDePolitica): Promise<Politica>;
  listarPoliticas(filtro: FiltroDePolitica): Promise<Pagina<Politica>>;
  obterPolitica(id: string): Promise<Politica>;
  atualizarPolitica(id: string, patch: PatchDePolitica): Promise<Politica>;
  removerPolitica(id: string): Promise<void>;
}

export function criarAbacService(deps: DependenciasDoAbacService): AbacService {
  function exigirCondicaoValida(condicao: Condicao): void {
    if (!condicaoDentroDosLimites(condicao)) throw new ErroDeAbac('condicao-invalida');
  }

  /** Carrega a política e recusa cedo se for de sistema. */
  async function carregarEditavel(id: string): Promise<Politica> {
    const politica = await deps.politicas.buscarPorId(id);
    if (politica === null) throw new ErroDeAbac('politica-nao-encontrada');
    if (politica.isSystem) throw new ErroDeAbac('politica-imutavel');
    return politica;
  }

  return {
    async criarPolitica(dados): Promise<Politica> {
      exigirCondicaoValida(dados.condition);
      const criada = await deps.politicas.criar(dados);
      deps.motor.invalidar();
      return criada;
    },

    async listarPoliticas(filtro): Promise<Pagina<Politica>> {
      const [items, total] = await Promise.all([
        deps.politicas.listar(filtro),
        deps.politicas.contar({
          ...(filtro.resourceType === undefined ? {} : { resourceType: filtro.resourceType }),
          ...(filtro.enabled === undefined ? {} : { enabled: filtro.enabled }),
        }),
      ]);
      return { items, total };
    },

    async obterPolitica(id): Promise<Politica> {
      const politica = await deps.politicas.buscarPorId(id);
      if (politica === null) throw new ErroDeAbac('politica-nao-encontrada');
      return politica;
    },

    async atualizarPolitica(id, patch): Promise<Politica> {
      const atual = await carregarEditavel(id);
      if (patch.condition !== undefined) exigirCondicaoValida(patch.condition);

      const atualizada = await deps.politicas.atualizar(id, {
        name: patch.name ?? atual.name,
        description: patch.description === undefined ? atual.description : patch.description,
        effect: patch.effect ?? atual.effect,
        resourceType: patch.resourceType ?? atual.resourceType,
        action: patch.action ?? atual.action,
        condition: patch.condition ?? atual.condition,
        priority: patch.priority ?? atual.priority,
        enabled: patch.enabled ?? atual.enabled,
      });
      // Já confirmamos a existência acima; o null aqui seria uma corrida improvável.
      if (atualizada === null) throw new ErroDeAbac('politica-nao-encontrada');
      deps.motor.invalidar();
      return atualizada;
    },

    async removerPolitica(id): Promise<void> {
      await carregarEditavel(id);
      await deps.politicas.remover(id);
      deps.motor.invalidar();
    },
  };
}
