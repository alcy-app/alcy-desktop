# Changelog

Todas as mudanças relevantes do Alcy são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## Unreleased

## [0.8.0] - 21/10/2026

### Added

- **Formulários nos flows**: o início do flow pode pedir dados antes de executar, com seções expansíveis, textos, quantidades, opções e checkboxes.
- **Aguardar ação humana**: um bloco pausa o ramo até alguém preencher um formulário, que pode escolher itens retornados por blocos anteriores.
- **Modo painéis**: esconde o diagrama e mostra os formulários e resultados escolhidos em cartões que podem ser posicionados livremente e acompanham a execução.
- Templates com uma galeria visual para criar flows em branco ou partir de exemplos prontos.
- Pastas no módulo de flows para agrupar e organizar os flows do workspace.
- O gravador de HAR também grava as requisições feitas pelos flows, com headers e resposta, para inspecionar e salvar junto com os envios manuais.
- Organização automática dos flows para alinhar os blocos e acompanhar suas conexões.
- O Display permite escolher o formato do resultado e navegar por respostas longas, expandindo ou recolhendo objetos JSON.

### Changed

- Logs e backups passam a ficar ao lado do executável. Quando a instalação não permite escrita, ficam na pasta de dados do aplicativo; os arquivos antigos em Documentos são preservados.
- Os menus de contexto mostram à direita o primeiro atalho configurado para cada ação.
- Os botões de expandir ou recolher tudo e localizar a requisição ativa ficam ao lado do menu de três pontos na barra de collections.
- A ordenação do conteúdo de collections e pastas fica apenas no menu de contexto, sem botão nas linhas da sidebar.
- Os flows usam blocos mais compactos, com um resumo de cada etapa e as opções de duplicar e excluir no menu de três pontos, inclusive nas anotações.
- Os scripts sugerem os módulos dentro de `require('…')` e os métodos das bibliotecas que vêm com o app, como lodash, crypto-js, moment e uuid.

### Fixed

- As conexões entre blocos próximos deixam de descer até abaixo do flow inteiro e passam a ligá-los diretamente.
- Variáveis não definidas no ambiente deixam de bloquear o envio; suas referências são mantidas na requisição.
- A busca no schema GraphQL mostra primeiro os nomes exatos e os candidatos com comprimento mais próximo do termo buscado.
- Os logs de erro passam a incluir as causas reconhecidas das falhas e os motivos encadeados dos erros da interface.
- Os menus de contexto dos flows deixam de ficar encobertos pelos outros itens da lista.
- Corrigido o erro que podia travar a interface ao acessar variáveis nos requests de um flow.
- Os blocos dos flows deixam de ficar borrados ao ampliar o canvas ou interagir com seus controles.

## [0.7.0] - 16/10/2026

### Added

- **Importação de HAR**: importe como uma nova coleção as chamadas gravadas em um arquivo `.har`, como o salvo pelas ferramentas de desenvolvedor do navegador.
- Busca nas variáveis do ambiente aberto, por nome ou valor; valores sensíveis nunca entram na busca.
- Na revisão da importação, escolha quais variáveis importar e onde guardá-las (ambiente novo, ambiente existente ou coleção), com nome, valor e sensibilidade já preenchidos a partir do arquivo. Variáveis usadas nas requisições mas sem definição também aparecem, e renomear uma atualiza as requisições importadas.
- **`require` em scripts**: scripts de pré-requisição e pós-resposta carregam bibliotecas com `require`. lodash, crypto-js, moment e uuid já vêm com o app, e `require('npm:pacote@versão')` baixa qualquer pacote do npm na primeira execução e o guarda para uso offline.
- **Requisições gRPC**: crie requisições gRPC, escolha o serviço e o método pela reflection do servidor ou por arquivos `.proto` e envie a mensagem em JSON, com sugestões dos campos. Use streaming, scripts, runner de coleções e flows; importe e compartilhe chamadas como comandos `grpcurl` ou imagens.

### Changed

- Interface mais compacta, com abas e seletor de ambiente menores e mais espaço para editar requisições e visualizar respostas.
- A barra no topo dos painéis da sidebar, com busca e filtros, fica fixa enquanto a lista abaixo dela rola.
- A edição em massa de headers, parâmetros, campos de formulário e variáveis agora é um único botão "Edição em massa"; desligado, mostra a tabela. Na aba Headers, ele fica sempre à direita.
- O seletor de formato da resposta mostra só o formato atual; os outros aparecem ao lado com um clique.
