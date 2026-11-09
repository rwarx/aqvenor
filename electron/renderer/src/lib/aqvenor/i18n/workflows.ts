import type { Locale } from "../types";

const entries: Record<string, [string, string, string]> = {
  "workflows.builder.subtitle": ["Choose a task, adapt its brief, and run it in your project.", "Выберите задачу, уточните задание и запустите агента в открытом проекте.", "Aufgabe wählen, Auftrag anpassen und im Projekt starten."],
  "workflows.builder.configure": ["Configure tools", "Настроить инструменты", "Werkzeuge konfigurieren"],
  "workflows.builder.choose": ["Choose a scenario", "Выберите сценарий", "Szenario wählen"],
  "workflows.builder.brief": ["Task brief", "Задание агенту", "Auftrag an den Agenten"],
  "workflows.builder.reset": ["Reset brief", "Вернуть шаблон", "Vorlage zurücksetzen"],
  "workflows.builder.workspace": ["Project folder", "Папка проекта", "Projektordner"],
  "workflows.builder.model": ["Model", "Модель", "Modell"],
  "workflows.builder.method": ["Working method", "Режим работы", "Arbeitsweise"],
  "workflows.builder.result": ["Follow the result", "Где смотреть результат", "Ergebnis verfolgen"],
  "workflows.builder.resultHint": ["Chat, files and trajectory", "Чат, файлы и траектория", "Chat, Dateien und Verlauf"],
  "workflows.builder.launchHint": ["Opens the scenario's chat. Other drafts stay in their chats.", "Откроется чат сценария. Черновики других чатов сохранятся.", "Öffnet den Szenario-Chat. Andere Chat-Entwürfe bleiben erhalten."],
  "workflows.builder.capabilities": ["Agent tools", "Инструменты агента", "Agentenwerkzeuge"],
  "workflows.builder.capabilitiesHint": ["Availability comes from the server. The chosen model decides when to use each tool.", "Доступность получена с сервера. Выбранная модель решает, когда использовать инструменты.", "Verfügbarkeit vom Server. Das gewählte Modell entscheidet über den Einsatz."],
  "workflows.builder.available": ["Available", "Доступно", "Verfügbar"],
  "workflows.builder.disabled": ["Disabled in settings", "Выключено в настройках", "In Einstellungen deaktiviert"],
  "workflows.builder.loading": ["Checking…", "Проверяем…", "Wird geprüft…"],
  "workflows.builder.loadError": ["Could not check tools", "Не удалось проверить инструменты", "Werkzeuge konnten nicht geprüft werden"],
  "workflows.builder.recent": ["Recent agent chats", "Недавние чаты с агентом", "Letzte Agenten-Chats"],
  "workflows.builder.recentEmpty": ["Chats with completed work will appear here. Start with a scenario above.", "Здесь появятся чаты с выполненной работой. Начните со сценария выше.", "Chats mit ausgeführten Aufgaben erscheinen hier. Starten Sie oben ein Szenario."],
  "workflows.capability.delegate_task": ["Subagents and delegation", "Субагенты и делегирование", "Subagenten und Delegierung"],
  "workflows.capability.run_command": ["Program execution", "Запуск программ", "Programme ausführen"],
  "workflows.capability.run_shell": ["CMD and PowerShell", "CMD и PowerShell", "CMD und PowerShell"],
  "workflows.customContext": ["Current project folder: {0}. Follow the project instructions and selected working method.", "Текущая папка проекта: {0}. Соблюдай инструкции проекта и выбранный режим работы.", "Aktueller Projektordner: {0}. Beachte Projektanweisungen und gewählte Arbeitsweise."],
  "workflows.transition.title": ["Project is being prepared", "Подготовка проекта", "Projekt wird vorbereitet"],
  "workflows.transition.description": ["Wait for the project switch or restart to finish.", "Дождитесь завершения смены проекта или перезапуска.", "Warten Sie, bis Projektwechsel oder Neustart abgeschlossen sind."],
  "workflows.tools.title": ["Required tool unavailable", "Нужный инструмент недоступен", "Benötigtes Werkzeug nicht verfügbar"],
  "workflows.tools.description": ["Enable the required agent tool in settings before launch.", "Перед запуском включите нужный инструмент агента в настройках.", "Aktivieren Sie das benötigte Agentenwerkzeug vor dem Start."],
  "workflows.empty.title": ["Add a task brief", "Добавьте задание", "Auftrag hinzufügen"],
  "workflows.empty.description": ["Describe the result the agent should produce.", "Опишите результат, который должен получить агент.", "Beschreiben Sie das gewünschte Ergebnis."],
  "agents.task": ["Delegated task", "Делегированная задача", "Delegierte Aufgabe"],
  "agents.pending": ["Queued", "Ожидает", "Wartet"],
  "agents.openChat": ["Open subagent chat", "Открыть чат субагента", "Subagent-Chat öffnen"],
  "agents.openError": ["Could not open subagent chat", "Не удалось открыть чат субагента", "Subagent-Chat konnte nicht geöffnet werden"],
  "agents.delegated.title": ["This chat belongs to an active parent run", "Чатом управляет родительский запуск", "Dieser Chat gehört zu einem aktiven übergeordneten Lauf"],
  "agents.delegated.hint": ["Messages become available after the parent run finishes. Command approvals and Stop are in the parent chat.", "Сообщения станут доступны после завершения родительского запуска. Подтверждения команд и остановка находятся в родительском чате.", "Nach Abschluss des übergeordneten Laufs können Sie Nachrichten senden. Befehlsfreigaben und Stopp befinden sich im übergeordneten Chat."],
  "agents.delegated.return": ["Open parent chat", "Открыть родительский чат", "Übergeordneten Chat öffnen"],
  "agents.started": ["{0} · started", "{0} · запущен", "{0} · gestartet"],
  "agents.finished": ["{0} · {1}", "{0} · {1}", "{0} · {1}"],
  "agents.failed": ["Failed", "Ошибка", "Fehlgeschlagen"],
  "agents.incomplete": ["Incomplete", "Не завершено", "Nicht abgeschlossen"],
  "settings.commands.allowShell": ["Allow CMD and PowerShell", "Разрешить CMD и PowerShell", "CMD und PowerShell erlauben"],
  "settings.commands.allowShellHint": ["Uses the execution policy, timeout and output limit.", "Используются политика запуска, таймаут и лимит вывода.", "Nutzt Ausführungsrichtlinie, Zeitlimit und Ausgabelimit."],
  "settings.agent.allowSubagents": ["Allow task delegation", "Разрешить делегирование задач", "Aufgabendelegierung erlauben"],
  "settings.agent.subagentsHint": ["Up to three tasks per run, with the same model and working method.", "До трёх задач за запуск, с той же моделью и режимом работы.", "Bis zu drei Aufgaben pro Lauf, mit gleichem Modell und gleicher Arbeitsweise."],
  "settings.capabilitiesUnavailable": ["Change program permissions in the desktop application.", "Разрешения запуска программ меняются в десктопном приложении.", "Programmberechtigungen werden in der Desktop-Anwendung geändert."],
  "run.stop.outputLimit": ["Model output limit reached", "Достигнут лимит вывода модели", "Ausgabelimit des Modells erreicht"],
  "run.stop.outputLimit.desc": ["The model's response was cut short. Partial text is saved. Reduce the task size or increase the model's output token limit before continuing.", "Ответ модели обрезан. Частичный текст сохранён. Уменьшите объём задания или увеличьте лимит токенов вывода модели перед продолжением.", "Die Modellantwort wurde abgeschnitten. Der bisherige Text wurde gespeichert. Verkleinern Sie den Auftrag oder erhöhen Sie das Ausgabetokenlimit des Modells, bevor Sie fortfahren."],
};

const recipes = {
  landing: [
    ["Build a landing page", "Create a small page and check its local interactions.", "Inspect", "Plan", "Build", "Verify", "Work in the current project: {0}. Inspect files, then create a landing page for a fictional design studio in index.html with embedded CSS/JS, system fonts and no external resources. Include services, work examples, FAQ and a local demo contact form with accessible validation and no data submission. Support widths from 320px. Use your tools, preserve existing work and verify the result."],
    ["Создать лендинг", "Создать небольшую страницу и проверить её локальные действия.", "Изучить", "Спланировать", "Создать", "Проверить", "Работай в текущем проекте: {0}. Осмотри файлы, затем создай лендинг вымышленной дизайн-студии в index.html со встроенными CSS/JS, системными шрифтами и без внешних ресурсов. Добавь услуги, примеры работ, FAQ и локальную демо-форму с доступной валидацией без отправки данных. Адаптация от 320px. Используй свои инструменты, сохрани существующие наработки и проверь результат."],
    ["Landingpage erstellen", "Eine kleine Seite erstellen und lokale Interaktionen prüfen.", "Untersuchen", "Planen", "Erstellen", "Prüfen", "Arbeite im aktuellen Projekt: {0}. Prüfe Dateien und erstelle eine Landingpage für ein fiktives Designstudio in index.html mit eingebettetem CSS/JS, Systemschriften und ohne externe Ressourcen. Füge Leistungen, Arbeitsbeispiele, FAQ und ein lokales Demoformular mit zugänglicher Validierung ohne Datenübertragung hinzu. Unterstütze Breiten ab 320px. Nutze deine Werkzeuge, erhalte bestehende Arbeit und prüfe das Ergebnis."],
  ],
  delegate: [
    ["Delegate a project review", "Give an independent analysis to a subagent and combine its findings.", "Scope", "Delegate", "Compare", "Summarize", "Work in the current project: {0}. Use delegate_task for an independent read-only review of structure and testing instructions. Inspect the project yourself, compare findings and return a plan with file references. Stay in planning mode: no file changes or program execution. Identify the subagent's result and unverified claims."],
    ["Делегировать обзор проекта", "Передать независимый анализ субагенту и собрать выводы.", "Выделить задачу", "Делегировать", "Сопоставить", "Подвести итог", "Работай в текущем проекте: {0}. Через delegate_task поручай субагенту независимый обзор структуры и инструкций по тестированию. Сам изучи проект, сопоставь выводы и подготовь план со ссылками на файлы. Оставайся в режиме планирования: не изменяй файлы и не запускай программы. Укажи результат субагента и непроверенные предположения."],
    ["Projektprüfung delegieren", "Eine unabhängige Analyse delegieren und Ergebnisse zusammenführen.", "Abgrenzen", "Delegieren", "Vergleichen", "Zusammenfassen", "Arbeite im aktuellen Projekt: {0}. Delegiere mit delegate_task eine unabhängige, rein lesende Prüfung von Struktur und Testanweisungen. Untersuche das Projekt selbst, vergleiche Ergebnisse und erstelle einen Plan mit Dateiverweisen. Bleibe im Planungsmodus: keine Dateiänderungen oder Programmausführung. Kennzeichne Subagentenergebnisse und ungeprüfte Annahmen."],
  ],
  shell: [
    ["Verify with shell commands", "Find and run the project's build and test commands.", "Read instructions", "Choose shell", "Run checks", "Explain failures", "Work in the current project: {0}. Inspect instructions and manifests, find suitable build/test commands and run them with run_shell using PowerShell or CMD in the project folder. Request required approvals. Do not install dependencies, publish, delete files or change the environment without an explicit task. Report commands, exit codes and actual outcomes; identify missing tools."],
    ["Проверить через команды", "Найти и выполнить команды сборки и тестирования проекта.", "Прочитать инструкции", "Выбрать оболочку", "Запустить проверки", "Разобрать ошибки", "Работай в текущем проекте: {0}. Изучи инструкции и манифесты, найди команды сборки и тестов и выполни их через run_shell с PowerShell или CMD в папке проекта. Запроси нужные подтверждения. Без отдельного задания не устанавливай зависимости, не публикуй, не удаляй файлы и не меняй окружение. Сообщи команды, коды завершения и реальные результаты; укажи отсутствующие инструменты."],
    ["Mit Shell-Befehlen prüfen", "Build- und Testbefehle des Projekts finden und ausführen.", "Anweisungen lesen", "Shell wählen", "Prüfungen ausführen", "Fehler erklären", "Arbeite im aktuellen Projekt: {0}. Lies Anweisungen und Manifeste, finde passende Build-/Testbefehle und führe sie über run_shell mit PowerShell oder CMD im Projektordner aus. Hole Freigaben ein. Ohne ausdrücklichen Auftrag keine Abhängigkeiten installieren, veröffentlichen, Dateien löschen oder Umgebung ändern. Nenne Befehle, Exitcodes, Ergebnisse und fehlende Werkzeuge."],
  ],
};

export function workflowCopy(locale: Locale): Record<string, string> {
  const index = locale === "en" ? 0 : locale === "ru" ? 1 : 2;
  const result = Object.fromEntries(Object.entries(entries).map(([key, values]) => [key, values[index]]));
  for (const [id, translations] of Object.entries(recipes)) {
    const values = translations[index];
    for (const [i, field] of ["name", "desc", "s1", "s2", "s3", "s4", "prompt"].entries()) result[`workflows.recipe.${id}.${field}`] = values[i];
  }
  return result;
}
