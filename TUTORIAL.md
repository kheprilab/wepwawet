# Wepwawet: disciplina de trabajo para agentes de código

*Cómo pasar de "el agente hace lo que le da la gana" a "el agente sigue tu proceso".*

---

## El problema que resuelve

Los agentes de código como Codex, Claude Code o GitHub Copilot son capaces de hacer cosas impresionantes, pero tienen un problema estructural: cada sesión empieza desde cero. Sin memoria entre sesiones, sin contexto de por qué existe un fichero, sin un proceso acordado de antemano. El agente adivina. A veces acierta, a veces no.

**wep** es un CLI que instala un harness en tu repositorio: un conjunto de ficheros de instrucciones, plantillas y wikis que dan al agente una forma de trabajar consistente y documentada, independientemente del agente que uses.

No es un agente. No llama a ninguna API. No tiene telemetría. Es simplemente un instalador que genera ficheros que el agente leerá en tu próxima sesión.

---

## Instalación

wep no está en npm todavía. Clona el repo y enlázalo de forma global:

```bash
git clone <repo-url>
cd wep
pnpm install
pnpm build
pnpm link --global
```

Verifica que funciona:

```bash
wep --version
wep --help
```

---

## Primer uso: inicializar un proyecto

Ve a cualquier repositorio donde uses un agente de código:

```bash
cd /ruta/a/mi-proyecto
wep init
```

wep detecta automáticamente qué agente tienes configurado (busca `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, etc.) y te pregunta si es correcto. Si quieres saltarte la pregunta:

```bash
wep init --target codex      # OpenAI Codex
wep init --target claude     # Claude Code
wep init --target copilot    # GitHub Copilot
wep init --target pi         # Pi
wep init --target all        # todos a la vez
```

Para ver qué crearía sin escribir nada:

```bash
wep init --target claude --dry-run
```

### Qué crea init

Siempre crea la capa neutral en `.wep/`:

```
.wep/
  config.json        ← configuración del proyecto (workflow por defecto, judge, etc.)
  policy.json        ← reglas de merge y presupuesto de contexto
  wiki/              ← documentación que el agente mantiene entre sesiones
  tasks/             ← cápsulas de tarea
  targets/           ← notas por target
```

Y los ficheros específicos del target. Para Claude Code, por ejemplo:

```
CLAUDE.md                                ← instrucciones principales
.claude/commands/wep-doctor.md
.claude/commands/wep-task.md
.claude/skills/wep-task/SKILL.md
.claude/skills/wep-workflow/SKILL.md
... (un skill por workflow)
```

**Regla clave**: si ya tienes un `CLAUDE.md` (o `AGENTS.md`, o `copilot-instructions.md`), wep **nunca lo sobreescribe**. En su lugar crea `CLAUDE.wep.suggested.md` con el contenido sugerido para que lo fusiones tú manualmente.

---

## El paso más importante: doctor

Después de init, abre tu agente en el proyecto y escríbele:

```
Run wep doctor.
```

El agente lee el harness instalado, audita el setup y **rellena `.wep/wiki/`** con contexto real del proyecto: arquitectura, convenciones, cómo correr los tests, decisiones de diseño. Esto es lo que convierte el esqueleto en un harness funcional.

También puedes correr el doctor desde el CLI para obtener un score de preparación:

```bash
wep doctor
wep doctor --json
```

El doctor te dice:
- qué targets están instalados
- si faltan ficheros del harness
- si hay ficheros `.suggested.md` pendientes de fusión
- si el judge está habilitado pero sin ficheros
- si la versión instalada difiere de la CLI actual
- un score de 0 a 100
- el siguiente paso sugerido

---

## Crear una tarea

Una vez el harness está instalado, simplemente habla con tu agente:

```
Arregla el bug donde la sesión expira demasiado pronto.
```

El agente leerá `CLAUDE.md` (o equivalente), creará una cápsula de tarea en `.wep/tasks/TASK-001-fix-session-expiry/`, elegirá el workflow apropiado (TDD para bugs) e implementará.

Si prefieres crear la cápsula desde el CLI (útil para CI o scripting):

```bash
wep task "Arregla bug de expiración de sesión"
wep task "Define API de facturas" --workflow SDD+EDD
```

Esto crea:

```
.wep/tasks/TASK-001-fix-session-expiry/
  task.md                ← descripción y objetivo
  context.md             ← contexto relevante cargado por el agente
  plan.md                ← plan de implementación
  acceptance-criteria.md ← criterios de aceptación
  review-checklist.md    ← checklist de revisión
```

### Compilar un brief

Si quieres un fichero único listo para pegar en una sesión de agente:

```bash
wep compile TASK-001
wep compile TASK-001 --target claude
```

Genera `.wep/tasks/TASK-001/exports/claude.md` con todo concatenado.

---

## Workflows

wep tiene 8 workflows predefinidos. El agente elige el más adecuado automáticamente según la descripción de la tarea, aunque puedes sobreescribirlo con `--workflow`.

| Workflow | Cuándo usarlo |
|---|---|
| `fast-patch` | Bug, fix, hotfix — el cambio mínimo seguro |
| `research-first` | Spike, exploración, investigación |
| `SDD` | Spec-Driven Development — spec antes de código |
| `TDD` | Test-Driven Development — tests antes de código |
| `EDD` | Example-Driven Development — ejemplos concretos antes de código |
| `SDD+TDD` | Spec + tests antes de código (para features críticas) |
| `SDD+EDD` | Spec + ejemplos concretos (para APIs o contratos) |
| `TDD+EDD` | Tests + ejemplos (validación exhaustiva) |
| `UI review` | Revisión de UI — el agente descubre qué herramientas tiene antes de actuar |

### El default y cómo cambiarlo

```bash
wep config set defaultWorkflow task-fit    # el agente elige por tarea (recomendado)
wep config set defaultWorkflow SDD+TDD     # todo el proyecto usa SDD+TDD por defecto
```

`task-fit` es el más flexible: el agente analiza la descripción y elige el workflow mínimo que se ajusta.

### Reglas de auto-asignación

Las reglas están en `config.json`:

```json
"workflowRules": [
  { "match": "bug|fix|regression|hotfix", "workflow": "fast-patch" },
  { "match": "research|spike|explore|investigate", "workflow": "research-first" },
  { "match": "ui|screen|component|layout|design", "workflow": "UI review" }
]
```

Si la descripción de la tarea contiene alguna de esas palabras clave, el workflow se asigna automáticamente.

---

## Configuración del proyecto

Todo vive en `.wep/config.json`. Puedes editarlo con el CLI:

```bash
wep config show
wep config set defaultWorkflow SDD+TDD
wep config set requireTaskCapsule true
wep config set requireWorkflowReason true
wep config set contextBudget proportional
```

### Presupuesto de contexto

| Valor | Qué carga el agente |
|---|---|
| `minimal` | Solo la política y la cápsula de tarea actual |
| `proportional` | Política, cápsula, y páginas de wiki relevantes |
| `thorough` | Revisión amplia de la wiki (para tareas de alto riesgo) |

---

## Actualizar el harness

Si actualizas la CLI, el harness instalado puede quedarse desactualizado. Compruébalo con:

```bash
wep doctor
```

Si el doctor detecta drift de versión, actualiza:

```bash
wep upgrade
wep upgrade --target claude
wep upgrade --dry-run   # previsualizar sin escribir
```

Los ficheros protegidos (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`) nunca se sobreescriben.

---

## El judge: revisión independiente (opcional)

El judge es un subagente independiente que revisa si la implementación cumple la cápsula de tarea. Está deshabilitado por defecto porque introduce latencia, pero es muy útil para features críticas o equipos que quieren un segundo par de ojos automático.

La idea es simple: el agente que implementa tiene un sesgo hacia su propio trabajo. El judge es un agente separado que solo tiene acceso al plan y a los criterios de aceptación, y verifica de forma independiente.

```bash
wep judge enable           # habilita e instala los ficheros del agente
wep judge enable --dry-run # previsualiza sin escribir
wep judge disable          # deshabilita (los ficheros se mantienen)
wep judge status           # muestra estado y ficheros presentes
```

Después de `judge enable`, encontrarás el fichero del agente en la ubicación nativa de tu target:

| Target | Fichero |
|---|---|
| Claude Code | `.claude/agents/wep-judge.md` |
| GitHub Copilot | `.github/agents/wep-judge.agent.md` |
| Codex | `.codex/agents/wep-judge.toml` |
| Pi | No soportado (Pi no tiene API nativa de subagentes) |

**Nota sobre el modelo**: wep no hardcodea ningún modelo. Después de habilitar el judge, edita el fichero generado y añade el modelo que prefieras. Consulta [docs/JUDGE.md](docs/JUDGE.md) para instrucciones detalladas por plataforma.

---

## Eliminar el harness

```bash
wep remove --target codex              # lista qué eliminaría (dry-run implícito)
wep remove --target codex --force      # elimina ficheros de skills de codex
wep remove --all --force               # elimina .wep/ y todos los ficheros de target
```

Los ficheros protegidos (`AGENTS.md`, `CLAUDE.md`, `copilot-instructions.md`) siempre se saltan — elimínalos manualmente si hace falta.

---

## Referencia rápida

| Objetivo | Comando |
|---|---|
| Instalar harness | `wep init` |
| Auditar setup | `wep doctor` |
| Ver estado | `wep status` |
| Crear cápsula de tarea | `wep task "<descripción>"` |
| Compilar brief para el agente | `wep compile TASK-001` |
| Ver configuración | `wep config show` |
| Cambiar workflow por defecto | `wep config set defaultWorkflow SDD+TDD` |
| Habilitar judge | `wep judge enable` |
| Habilitar tracing observacional | `wep trace enable` |
| Ver informe de conformidad | `wep trace report` |
| Actualizar harness | `wep upgrade` |
| Eliminar harness | `wep remove --target codex --force` |

---

## Preguntas frecuentes

**¿Tengo que usar el CLI para cada tarea?**
No. El flujo normal es hablarle directamente al agente. El CLI es útil para CI, scripting, o cuando quieres crear una cápsula antes de abrir el agente.

**¿Qué pasa si ya tengo un `CLAUDE.md` con mis instrucciones?**
wep nunca lo sobreescribe. Crea `CLAUDE.wep.suggested.md` con el contenido sugerido. Tú fusionas manualmente. El doctor te avisará mientras haya un fichero `.suggested.md` pendiente.

**¿Funciona con varios agentes a la vez?**
Sí. Usa `--target all` o instala targets de forma individual. La capa neutral en `.wep/` es la misma para todos; solo cambian los adaptadores de target.

**¿El agente puede cambiar el workflow durante la tarea?**
Sí, con `requireWorkflowReason: true` el agente debe justificar cualquier cambio de workflow. Queda registrado en la cápsula.

**¿Cómo sé si el setup está bien?**
`wep doctor` te da un score de 0 a 100 y una lista de problemas concretos con el comando exacto para solucionarlos.
