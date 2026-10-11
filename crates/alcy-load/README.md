# alcy-load

Núcleo Rust compartilhado por flows de carga e consumidores independentes.
Não depende de Tauri, `alcy-app`, grafo de flow ou workspace.

## Uso independente

```bash
cargo run -p alcy-load --example standalone
```

O exemplo monta um `LoadPlan` tipado, executa dois VUs com três iterações cada
e verifica um threshold de seis requests. O transporte é **simulado**: não
abre conexões nem mede performance HTTP real.

Para executar HTTP, implemente `LoadTransport` com o cliente escolhido,
forneça `LoadCancellation` e um `LoadRunSink`, e chame
`execute_load_plan_report`. O runner exige um runtime Tokio com timer habilitado.
O transporte deve permitir que o descarte da future cancele a operação.

`LoadTransport::execute_instrumented` pode retornar `LoadRequestTimings` para
DNS, conexão, TLS, envio, espera e recebimento. Fases não observadas permanecem
ausentes — o runner nunca inventa zero. A duração total é medida pelo runner.
Cada `LoadRequestPlan` também pode declarar `timeout`; ao expirar, a request é
contabilizada como falha e a future do transporte é descartada.

Planos são validados antes de qualquer efeito. Os relatórios contêm agregados,
não corpos de resposta. Percentis usam amostras numéricas temporárias removidas
ao encerrar normalmente, cancelar ou falhar. Recuperação após crash e escrita
assíncrona de amostras em lotes continuam pendentes.

## Orçamentos de execução

`execute_load_plan_report` e `LoadPlan::validate` usam `LoadRunLimits::default`:

- 64 cenários; soma dos picos de VUs até 4.096;
- taxa aberta até 100.000 chegadas/segundo por cenário;
- até 1.024 requests/efeitos declarativos por iteração;
- duração configurada e soma de timers por iteração até 24 horas;
- até 64 MiB de amostras Trend brutas, compartilhados por toda a execução.

Esses valores são políticas iniciais, não capacidade medida do Windows de
referência. `validate_with_limits` e `execute_load_plan_report_with_limits`
permitem fornecer outro orçamento explicitamente, sem modificar a carga.
O compilador/importador desktop usa os padrões; configurar budgets na UI ainda
não faz parte desta entrega.

Excesso de configuração falha antes de requests ou alocação de VUs. Excesso do
budget de amostras aborta com erro, sem truncar dados ou aprovar thresholds.
Percentis abrem no máximo 32 inputs e um output por etapa de merge. Durante a
ordenação podem existir até três cópias dos bytes numéricos (brutos e duas
gerações de trabalho), além dos metadados e overhead do filesystem.

Não são limites globais de memória ou wall-clock: payloads, cookies por VU e
transporte ainda precisam de políticas próprias; cenários finitos sem
`maxDuration` continuam sem deadline imposto pelo runner.

O crate é interno (`publish = false`); sua API ainda não é um SDK estável.

## Corpos e lifecycle

Cada cenário pode informar uma cadeia legada em `requests` **ou** uma árvore
em `body`; os dois campos juntos são inválidos. `LoadStep` executa Request,
Timer fixo, ConfigureSession, Check de status, Metric, Repeat, ForEach,
Select, OncePerVu, TimeBox, Group e Dataset com linhas resolvidas.
O validador limita aninhamento a 32 e considera multiplicadores de passos e
timers antes da execução; branches pulados também precisam ser válidos.

`ForEach` resolve templates em suas strings e restaura sua variável ao sair.
Ele também pode receber um array JSON de uma variável do VU (por exemplo,
extraída no setup); nesse modo `max_items` é obrigatório e limita a expansão
antes de o corpo iniciar. Itens estruturados são serializados como JSON quando
entregues à variável de cada volta. `Select` resolve templates antes de comparar
uma variável e aceita `equals` (padrão), `notEquals`, `exists` e `notExists`.
`OncePerVu` persiste entre iterações. `TimeBox`
repete seu corpo até um deadline rígido: uma future em curso é descartada,
sem lançar tarefas órfãs. Group propaga tags e pode emitir `group_duration`
ao terminar. A transação escolhe se essa duração inclui Timers e se emite a
amostra-pai; tags voltam ao escopo anterior ao sair.

`LoadPlan.setup`/`teardown` recebem `LoadLifecyclePlan` com corpo e timeout.
Setup roda uma vez; suas variáveis inicializam cada VU por cópia. Teardown
recebe o estado de setup, aguarda cenários e também é tentado após erro de
cenário. Não começa após cancelamento explícito nem após falha de setup.
O primeiro erro é preservado se teardown também falhar. Requests de lifecycle
participam dos agregados; não são contadas como iterações de cenário.

ConfigureSession define variáveis string. Corpos/headers de requests aceitam
`{{nome}}`, incluindo `__VU` (base 1) e `__ITER` (base 0) nos cenários; nomes
reservados não podem ser sobrescritos pelo plano. Valores ausentes e headers
resolvidos inválidos falham antes da request; URLs continuam estáticas.

`LoadDatasetPlan.rows` usa dados imutáveis compartilhados por Arc, com cursor
por dataset/VU. `recycle` precisa ser explícito para repetir linhas; esgotar
dados sem reciclagem aborta a execução. As linhas precisam ter as mesmas
colunas. Há limites de 8 MiB de datasets por plano e 1 MiB por conjunto de
variáveis/linha. O consumidor resolve CSV/JSON/assets antes de entregar o
plano: leitura de arquivos continua fora do runner. Extract por JSON Pointer e
Script seguro executam no worker isolado do VU; outros extractors e suspensões
de Script continuam pendentes.

