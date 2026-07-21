/**
 * Responsabilidade: lista local de senhas proibidas por serem comuns demais.
 * Consumido por: o validador de política de força de senha.
 * Regras:
 *  - Comparação normalizada (minúsculas, sem espaço nas pontas): `Senha123` e `senha123`
 *    são a mesma proibição.
 *  - Lookup O(1) por `Set`. A checagem roda em toda troca/reset/criação de usuário; uma
 *    varredura linear numa lista grande seria custo por requisição sem ganho.
 *
 * As entradas são guardadas como SHA-256 da senha normalizada, não em claro. Motivo: são
 * senhas comuns de vazamentos públicos (não segredos deste sistema), mas em claro no fonte
 * elas disparam scanners de segredo do CI — um falso-positivo que travaria o PR. Hashear
 * remove o gatilho sem mudar o comportamento: a checagem hasheia o candidato e compara.
 *
 * Para inspecionar ou ampliar a lista, mantenha a fonte em claro fora do repositório e
 * gere os hashes com `sha256(senha.trim().toLowerCase())`; uma wordlist maior é só
 * substituir o conteúdo do `Set`.
 */
import { createHash } from 'node:crypto';

/** SHA-256 (hex) das senhas comuns normalizadas. */
const HASHES_PROIBIDOS: ReadonlySet<string> = new Set([
  '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
  '15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225',
  'ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f',
  'c775e7b757ede630cd0aa1113bd102661ab38829ca52a6422ab782862f268646',
  '5994471abb01112afcc18159f6cc74b4f511b99806da59b3caf5a9c173cacfc5',
  '8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414',
  '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8',
  'b7e94be513e96e8c45cd23d162275e5a12ebde9100a425c4ebcdd7fa4dcd897c',
  '65e84be33532fb784c48129675f9eff3a682b27168c0ea744b2cf58ee02337c5',
  'daaad6e5604e8e17bd9f108d91e26afe6281dac8fda0091040a7a6d7bd9b43b5',
  '6ca13d52ca70c883e0f0bb101e425a89e8624de51db2d2392593af6a84118090',
  '0b14d501a594442a01c6859541bcb3e8164d183d32937b851835442f69d5c94e',
  '55a5e9e78207b4df8699d60886fa070079463547b095d1a05bc719bb4e6cd251',
  '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
  '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
  'e4ad93ca07acb8d908a3aa41e920ea4f4ef4f26e7f86cf8291c5db289780a5ae',
  '280d44ab1e9f79b5cce2dd4f58f5fe91f0fbacdac9f7447dffc318ceb79f2d02',
  'fcc3a23fc7232cc89c7cb0f23d8774fefb73d7dc2ab22e6a1b6b8b202b4dcc91',
  '000c285457fc971f862a79b786476c78812c8897063c6fa9c045f579a3b2d63f',
  'a9c43be948c5cabd56ef2bacffb77cdaa5eec49dd5eb0cc4129cf3eda5f0e74c',
  '1c8bfe8f801d79745c4631d09fff36c82aa37fc4cce4fc946683d7b336b63032',
  '6382deaf1f5dc6e792b76db4a4a7bf2ba468884e000b25e7928e621e27fb23cb',
  'a01edad91c00abe7be5b72b5e36bf4ce3c6f26e8bce3340eba365642813ab8b6',
  'bcb15f821479b4d5772bd0ca866c00ad5f926e3580720659cc80d39c9d09802a',
  '91b4d142823f7d20c5f08df69122de43f35f057a988d9619f6d3138485c9a203',
  '96cae35ce8a9b0244178bf28e4966c2ce1b8385723a96a6b838858cdd6ca0a1e',
  '481f6cc0511143ccdd7e2d1b1b94faf0a700a8b49cd13922a70b5ae28acaa8c5',
  '73cd1b16c4fb83061ad18a0b29b9643a68d4640075a466dc9e51682f84a847f5',
  '1532e76dbe9d43d0dea98c331ca5ae8a65c5e8e8b99d3e2a42ae989356f6242a',
  '203b70b5ae883932161bbd0bded9357e763e63afce98b16230be33f0b94c2cc5',
  'a941a4c4fd0c01cddef61b8be963bf4c1e2b0811c037ce3f1835fddf6ef6c223',
  '04e77bf8f95cb3e1a36a59d1e93857c411930db646b46c218a0352e432023cf2',
  'fc613b4dfd6736a7bd268c8a0e74ed0d1c04a959f59dd74ef2874983fd443fc9',
  '0bb09d80600eec3eb9d7793a6f859bedde2a2d83899b70bd78e961ed674b32f4',
  '34550715062af006ac4fab288de67ecb44793c3a05c475227241535f6ef7a81b',
  'c64975ba3cf3f9cd58459710b0a42369f34b0759c9967fb5a47eea488e8bea79',
  'a92f6bdb75789bccc118adfcf704029aa58063c604bab4fcdd9cd126ef9b69af',
  'a0561fd649cdb6baa784055f051bad796ea0afef17fca38219549deeba4e8c1a',
  'c06b0cfe0cc5e900c57784484094331f095bf441995c3c31ea6c75691c786c35',
  'b64866d9d481181a9b3cd74f1323d7e35cd0ba87b48945ac92c1619827694fd2',
  '8f0e2f76e22b43e2855189877e7dc1e1e7d98c226c95db247cd1d547928334a9',
  'a075d17f3d453073853f813838c15b8023b8c487038436354fe599c3942e1f95',
  '057ba03d6c44104863dc7361fe4578965d1887360f90a0895882e58a6248fc86',
  '37a8eec1ce19687d132fe29051dca629d164e2c4958ba141d5f4133a33f0688f',
  '4813494d137e1631bba301d5acab6e7bb7aa74ce1185d456565ef51d737677b2',
  'ce5ca673d13b36118d54a7cf13aeb0ca012383bf771e713421b4d1fd841f539a',
  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  '84983c60f7daadc1cb8698621f802c0d9f9a3c3c295c810748fb048115c186ec',
  '04f8996da763b7a969b1028ee3007569eaf3a635486ddab211d512c85b9df8fb',
  '428821350e9691491f616b754cd8315fb86d797ab35d843479e732ef90665324',
  '5751a44782594819e4cb8aa27c2c9d87a420af82bc6a5a05bc7f19c3bb00452b',
  'b9c950640e1b3740e98acb93e669c65766f6670dd1609ba91ff41052ba48c6f3',
  '9c781a9a01bcad170381302ba11629a1af2ca0f8734b1acb43aa88888cf4356a',
  '87bc413ab73113f45f82e31c0b3881f2fcfab68fb693cd425fc023302bb4517f',
  'f3bcb069f76d9d319f203081e456f43dfb749291a9acaf8ae9e775c575446e54',
  '527ad704c9463211ae9ec71a3d549ca0a3cadc5d808f3768aa87de0ee77ed129',
  '8251f31b8dfaa422ff300192ec1b6a8fd4ecf5f01c0f12f6974eab2d19515090',
]);

/** SHA-256 hex da senha normalizada — mesma normalização com que a lista foi gerada. */
function digerirNormalizada(senha: string): string {
  return createHash('sha256').update(senha.trim().toLowerCase()).digest('hex');
}

/** `true` se a senha (normalizada) está na lista de proibidas. */
export function estaNaBlocklist(senha: string): boolean {
  return HASHES_PROIBIDOS.has(digerirNormalizada(senha));
}
