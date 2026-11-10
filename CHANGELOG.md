# Changelog

Todas as mudanças relevantes do Alcy são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## Unreleased

## [0.10.0] - 2026-11-08

### Added

- **Git**: inicie um histórico git no próprio workspace, com commits, branches, mesclagem item a item e histórico.
- **Posição do chat**: arraste o painel do agente pelo cabeçalho para a direita ou a parte de baixo da tela, ou para a esquerda, onde ele vira um módulo da barra lateral. A posição também pode ser escolhida em Configurações › Agente e fica salva.
- **Aparência "Padrão do sistema"**: em Configurações › Aparência, o Alcy pode seguir o tema claro ou escuro do sistema operacional.
- **Comentários no body JSON**: comente trechos do body com Ctrl+/ ou Ctrl+; (uma linha vira `//`, várias viram um bloco `/* */`).
- **Exemplos de requisição**: salve várias chamadas de uma mesma requisição, cada uma com seus parâmetros e a resposta esperada. 
- Exporte e importe flows em arquivos Alcy, mantendo as referências ou incorporando requisições e variáveis no próprio flow.
- Localizar e substituir nos editores de requisição: troque uma ocorrência ou todas de uma vez, inclusive só dentro do texto selecionado.

### Changed

- Pastas também podem ser exportadas no formato Alcy.
- Com um texto selecionado no editor, Ctrl+F já abre a busca procurando por ele.
- O menu de opções de um monitor de valores tem "Mencionar no chat", como as demais listas.
- Selecione um trecho da resposta e use "Compartilhar como imagem".
- Variáveis `{{nome}}` ficam mais fáceis de ler, selecionar e editar na URL, nos parâmetros e no body.
- Nos flows, um clique só seleciona o bloco; as configurações abrem com duplo clique ou pela opção "Gerenciar" do menu do bloco.
- Nas variáveis de um ambiente, a busca, "Adicionar variável" e os nomes das colunas ficam sempre visíveis no topo.
- Nos flows, os valores numéricos dos blocos, como o máximo de iterações do loop e a duração da espera, passam a aceitar variáveis.

### Fixed

- Copiar a resposta preserva a formatação exibida no Alcy.
- Nomes longos de variável não ultrapassam mais a caixa de descrição das sugestões no body.
- Nos flows, o campo de URL das requisições avulsas volta a ocupar a largura da linha, em vez de ficar espremido ao lado do método.
- Ao voltar para uma aba, a resposta continua onde você parou.
- No console, os detalhes de uma requisição mostram também o body enviado, junto dos headers.
- Ctrl+Z nos editores (body, scripts, query e variables) volta a desfazer colagens e linhas novas no Linux, e o histórico continua disponível depois de trocar de seção ou de aba.
- No Windows, Ctrl+F fora dos editores não abre mais a busca do navegador.
