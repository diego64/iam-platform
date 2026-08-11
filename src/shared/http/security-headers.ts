/**
 * Responsabilidade: a política de cabeçalhos de segurança que vale para toda resposta.
 * Consumido por: `app.ts`, como opções do `@fastify/helmet`.
 * Regras:
 *  - Vale para 200, 4xx e 5xx. Um 401 sem `nosniff` expõe tanto quanto um 200 sem.
 *  - Escrita por extenso, nunca herdada. Ver o comentário da política de conteúdo.
 */
import type { FastifyHelmetOptions } from '@fastify/helmet';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Sobreposição da política de cabeçalhos para uma rota específica.
     *
     * O plugin lê esta chave da configuração da rota e a mescla sobre a global. Os tipos
     * dele só declaram o atalho `helmet` nas opções de rota, não aqui — e é aqui que o
     * gancho `onRoute` precisa escrever para alcançar rota registrada por outro plugin.
     */
    helmet?: FastifyHelmetOptions;
  }
}

/** Dois anos, o piso pedido por quem mantém a lista de pré-carga dos navegadores. */
const HSTS_MAX_AGE_SEGUNDOS = 63_072_000;

/**
 * Política de conteúdo de uma API que só devolve JSON: nega tudo.
 *
 * O default do plugin é a política do helmet, desenhada para aplicação que serve HTML —
 * libera `script-src 'self'`, `img-src`, `style-src` e mais oito diretivas. Nenhuma rota
 * daqui devolve documento, então herdar aquilo é publicar uma permissão que não se
 * pretende dar: no dia em que uma resposta escapar como `text/html` (erro de handler,
 * conteúdo refletido), a política herdada executa script vindo da própria origem.
 *
 * `sandbox` sem token entra junto: se algo for interpretado como documento, roda em origem
 * opaca — sem script, sem formulário, sem navegação de topo.
 */
const POLITICA_DE_CONTEUDO = {
  'default-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  sandbox: [],
} as const;

/**
 * Política relaxada do Swagger UI, que é HTML com script e estilo embutidos.
 *
 * Só existe fora de produção, e alcança apenas as rotas sob o prefixo da documentação: quem
 * a aplica é um gancho `onRoute` que escreve `config.helmet` naquelas rotas, mecanismo de
 * sobreposição por rota do próprio plugin.
 *
 * **Não** tente trocar isso por um registro aninhado com opções próprias. O plugin é
 * publicado com `fastify-plugin`, então o registro escapa do escopo e **sobrescreve a
 * configuração global** — o afrouxamento vazaria para a API inteira, que é o oposto da
 * intenção, e sem sintoma visível.
 */
const POLITICA_DA_DOCUMENTACAO = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'frame-ancestors': ["'none'"],
} as const;

/**
 * Opções do helmet para as rotas de API.
 *
 * `preload` fica de fora do HSTS de propósito: entrar na lista de pré-carga dos navegadores
 * é decisão de quem é dono do domínio, e sair dela leva semanas. Ligar aqui, por
 * conveniência, comprometeria todo subdomínio presente e futuro sem que ninguém tivesse
 * decidido isso.
 */
export const CABECALHOS_DE_SEGURANCA: FastifyHelmetOptions = {
  contentSecurityPolicy: {
    // Sem isto o plugin **mescla** as diretivas abaixo sobre o conjunto default dele, e
    // entram sem convite `script-src 'self'`, `style-src ... 'unsafe-inline'`, `img-src`,
    // `font-src` e outras. O resultado é uma política que parece restritiva — porque as
    // linhas que se escreveu estão todas lá — e libera script da própria origem.
    useDefaults: false,
    directives: { ...POLITICA_DE_CONTEUDO },
  },
  strictTransportSecurity: {
    maxAge: HSTS_MAX_AGE_SEGUNDOS,
    includeSubDomains: true,
    preload: false,
  },
  // `DENY` e não o `SAMEORIGIN` do default: nenhuma resposta desta API precisa ser
  // enquadrada, nem pela própria origem.
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  noSniff: true,
};

/** Serializa as diretivas no formato do cabeçalho: `nome valor valor; nome; ...`. */
function serializarPolitica(politica: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(politica)
    .map(([nome, valores]) => (valores.length === 0 ? nome : `${nome} ${valores.join(' ')}`))
    .join('; ');
}

/**
 * Os mesmos cabeçalhos, prontos para serem escritos à mão.
 *
 * Existem porque o Fastify emite alguns erros **antes de haver rota** — caminho longo
 * demais, versão de cabeçalho inválida — e esse caminho não passa por gancho nenhum: nem
 * `onRequest`, onde o plugin aplica os cabeçalhos, nem `onSend`. Sem isto, justamente as
 * respostas a requisições malformadas sairiam sem política alguma.
 *
 * Derivados das mesmas constantes acima, não copiados: uma diretiva que mude ali muda aqui
 * junto, e o teste compara os dois lados para o caso de alguém acrescentar um cabeçalho só
 * de um lado.
 */
export const CABECALHOS_DE_ERRO_SEM_ROTA: Readonly<Record<string, string>> = {
  'content-security-policy': serializarPolitica(POLITICA_DE_CONTEUDO),
  'strict-transport-security': `max-age=${String(HSTS_MAX_AGE_SEGUNDOS)}; includeSubDomains`,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
};

/** Opções do helmet para o escopo da documentação — ver `POLITICA_DA_DOCUMENTACAO`. */
export const CABECALHOS_DA_DOCUMENTACAO: FastifyHelmetOptions = {
  ...CABECALHOS_DE_SEGURANCA,
  contentSecurityPolicy: { useDefaults: false, directives: { ...POLITICA_DA_DOCUMENTACAO } },
  // A UI carrega fonte e imagem próprias; `same-origin` no CORP bastaria, mas o COOP
  // isolado quebra o carregamento do bundle em alguns navegadores sem ganho aqui: a
  // documentação não manipula credencial.
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
};
