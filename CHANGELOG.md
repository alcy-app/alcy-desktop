# Changelog

Todas as mudanças relevantes do Alcy são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## Unreleased

### Added

- **Importação de HAR**: importe como uma nova coleção as chamadas gravadas em um arquivo `.har`, como o salvo pelas ferramentas de desenvolvedor do navegador.
- Busca nas variáveis do ambiente aberto, por nome ou valor; valores sensíveis nunca entram na busca.
- **`require` em scripts**: scripts de pré-requisição e pós-resposta carregam bibliotecas com `require`. lodash, crypto-js, moment e uuid já vêm com o app, e `require('npm:pacote@versão')` baixa qualquer pacote do npm na primeira execução e o guarda para uso offline.

### Changed

- Interface mais compacta, com abas e seletor de ambiente menores e mais espaço para editar requisições e visualizar respostas.
- A barra no topo dos painéis da sidebar, com busca e filtros, fica fixa enquanto a lista abaixo dela rola.
- A edição em massa de headers, parâmetros, campos de formulário e variáveis agora é um único botão "Edição em massa"; desligado, mostra a tabela. Na aba Headers, ele fica sempre à direita.
- O seletor de formato da resposta mostra só o formato atual; os outros aparecem ao lado com um clique.
