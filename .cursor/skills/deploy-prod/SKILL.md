---
name: deploy-prod
description: >-
  Deploys my-sub-api by committing current work to main, pushing origin/main,
  checking out prod, merging main into prod, and pushing origin/prod.
  Use when the user says 部署, deploy, 上线, 发布, 推到生产, or asks to ship this Worker.
---

# 部署到 prod

本仓库用 **main 开发、prod 上线**。用户说「部署」时按下面做，不必再问步骤。

不要 `wrangler deploy`，除非用户另外明确要求。不要 `--force`、不要 `--no-verify`、不要改 git config。

## 步骤

1. `git status` / `git diff` / `git log -5 --oneline`。有未提交改动就先处理。
2. 当前不在 `main` 就 `git checkout main`（有未提交改动则一并带过去，不要丢）。
3. 把本次修改提交到 **main**。提交说明跟仓库现有风格：`feat: …` / `fix: …`，一两句说为什么。空提交不要做。
4. `git push origin main`
5. `git checkout prod`
6. `git merge main`（把 main 合进 prod，不是反过来）
7. `git push origin prod`
8. `git checkout main`，停在开发分支

## 注意

- 冲突就停下来，不要擅自用 theirs/ours 糊过去。
- `prod` 是上线分支，禁止 force push。
- 只推 `main` 和 `prod`，不要顺手推别的远程分支。
