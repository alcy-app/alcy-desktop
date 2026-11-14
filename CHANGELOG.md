# Changelog

Todas as mudanças relevantes do Alcy são registradas neste arquivo.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adota o [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## Unreleased

### Added

- **Git**: os ambientes entram nos commits e chegam completos a quem clonar o workspace. A opção vem marcada ao iniciar o Git e, num repositório que ainda não os versiona, fica em "Versionar ambientes", no menu do repositório.
- **Git**: mock servers, documentos e os arquivos usados pelos flows (como datasets) também entram nos commits e chegam a quem clonar ou fizer pull.
- Botão para formatar o body raw em JSON ou XML, mantendo comentários e variáveis `{{nome}}` como estão.
- Menu de botão direito no editor do body, com Copiar, Colar e comentar a linha, o texto selecionado ou tudo.

### Changed

- Com parte do texto selecionada, Ctrl+/ e Ctrl+; comentam só o trecho selecionado (`/* */`), não mais a linha inteira.

### Fixed

- Fazer pull com mesclagem num workspace git que não versiona ambientes não apaga mais os ambientes de quem os versiona.

### Security

- Tokens, senhas e outros segredos digitados na autenticação de coleções, requisições e flows não vão mais para o git: ficam criptografados neste computador. Para compartilhar um segredo com o time, use uma variável de ambiente sensível.
- Esses segredos também ficam criptografados no histórico de envios e nas abas reabertas ao abrir o workspace, que antes os guardavam em texto na pasta do workspace.
- **Confiança em scripts**: scripts de coleções importadas e de workspaces abertos pela primeira vez só rodam depois que você confia neles. Até lá, as requisições são enviadas sem os scripts, e o Alcy mostra um cadeado na aba Scripts e avisa na resposta. Antes de confiar, dá para ver os scripts e os pacotes npm que eles vão baixar.
- **Salvar e exportar**: respostas, HAR, coleções, imagens, webclients, flows, relatórios e documentos só são gravados no lugar que você escolhe na janela de salvar. Nenhuma parte da interface consegue mais gravar esses arquivos em outro lugar sem passar por ela.
- **Importar**: coleções, flows, datasets de carga, imagens de documentos, certificados CA e o arquivo de dados do runner só são lidos de arquivos que você escolheu na janela de abrir ou arrastou para o Alcy.
- **Pastas de workspace**: o Alcy só lê e grava em pastas de workspaces que você abriu, criou ou escolheu. Confiar numa pasta para o git também só vale para essas pastas.

## [0.10.0] - 2026-11-10

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
- A mensagem de commit e os demais campos de texto não mostram mais sugestões do navegador com o que já foi digitado.
