# Публикация репозитория на GitHub

Локальный репозиторий готов: ветка `main`, 7 коммитов, `.env` в истории отсутствует.
Осталось создать репозиторий на GitHub и дать этой машине право в него писать.

## Вариант 1 — ключ SSH (рекомендуется, токен в переписке не нужен)

Публичный ключ этой машины:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHAViXdLau/OJaxr37rt64LUzpPvqLoMMsTbC2e0SwUc vibecode-crm-dashboard
```

1. GitHub → Settings → SSH and GPG keys → New SSH key → вставить строку выше.
2. Создать пустой репозиторий: New repository, имя `crm-funnel-dashboard`,
   **без** README, .gitignore и лицензии (иначе первый push конфликтует).
3. Сообщить адрес вида `git@github.com:<аккаунт>/crm-funnel-dashboard.git`.

Дальше публикация выполняется командами:

```bash
git remote add origin git@github.com:<аккаунт>/crm-funnel-dashboard.git
git push -u origin main
```

## Вариант 2 — GitHub CLI

```bash
brew install gh
gh auth login          # вход через браузер, выполняется в Терминале пользователем
gh repo create crm-funnel-dashboard --private --source=. --remote=origin --push
```

`--public` вместо `--private` делает репозиторий открытым (это требует регламент
проверки).

## Вариант 3 — токен доступа

Fine-grained token с правом Contents: Read and write на один репозиторий. Токен
вставляется не в переписку, а в хранилище учётных данных:

```bash
git remote add origin https://github.com/<аккаунт>/crm-funnel-dashboard.git
git push -u origin main     # логин — аккаунт, пароль — токен
```

## После публикации

```bash
git log --oneline                     # 7 коммитов
git log --all -p | grep -iE "vibe_(api|app)_|api[_-]?key"   # пусто
```

Ключи в репозиторий не входят: `BITRIX_API_KEY`, `BITRIX_API_BASE_URL`,
`BITRIX_PORTAL_DOMAIN` задаются окружением или локальным `.env`, который исключён
через `.gitignore`.
