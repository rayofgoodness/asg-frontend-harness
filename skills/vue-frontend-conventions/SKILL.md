---
name: vue-frontend-conventions
description: Default Vue 3 / Nuxt / Laravel-frontend conventions used by task-harness reviewers and implementers when the project itself does not define a rule.
---

These are fallbacks. A project rule, linter config, or a strong pattern in sibling files always wins.

## Vue SFC
- `<script setup lang="ts">` with Composition API if the project already uses it; never mix Options API into a Composition API codebase or vice versa.
- Block order follows the project; default `<script>` → `<template>` → `<style>`.
- Props via `defineProps<T>()` with typed interface, defaults via `withDefaults`; emits via typed `defineEmits`. Never mutate props; use `v-model` / `defineModel` for two-way binding.
- Do not destructure props or `reactive()` objects without `toRefs`.
- Component names PascalCase, multi-word; files named like the component.
- Every `v-for` has a stable `:key` (not the index when the list can reorder).
- No `v-if` together with `v-for` on the same element.
- Side effects in `onMounted`/`watch`; clean up listeners, timers, observers in `onBeforeUnmount`/`onScopeDispose`.
- Shared logic goes to composables `useXxx` in the project's composables folder; composables return refs, not raw values.
- State: use the store library the project uses (Pinia) — no ad-hoc global reactive singletons.

## Templates & UI
- No hardcoded user-facing strings if the project has i18n (`$t`, `__()`, `trans()`).
- No hardcoded colors, spacing, z-indexes when design tokens / Tailwind theme / SCSS variables exist.
- Interactive elements are `<button>`/`<a>`, not clickable `<div>`; images have `alt`; form fields have labels.
- `v-html` only with sanitized content.
- Loading, empty and error states are handled for every async UI.

## Nuxt specifics
- Data fetching via `useFetch`/`useAsyncData` with explicit keys; no `fetch` in `setup` without SSR consideration.
- Browser-only code inside `onMounted`, `import.meta.client`, or `<ClientOnly>`.
- Rely on auto-imports consistently with the project (don't add explicit imports where the codebase doesn't).

## Laravel-served frontend (Blade / Inertia / Vite)
- Blade: escaped output `{{ }}` by default; `{!! !!}` only for trusted HTML.
- Assets through `@vite`, not hardcoded paths.
- Inertia: page props typed; forms via `useForm`; routes via Ziggy `route()` if present.

## TypeScript / JS
- Guard clauses and early returns for new and changed code: see the `guard-clauses` skill of this plugin.
- No `any` unless the surrounding code uses it; prefer project types from the shared types folder.
- No `console.log`/`debugger` in committed code.
- Async errors handled where the user would otherwise see a broken state.

## Styles
- Follow the project's method (Tailwind utilities, scoped SCSS, BEM). `scoped` styles in components unless the project uses another approach.
- No `!important` unless overriding third-party CSS that cannot be targeted otherwise.

## PHP (when the change touches backend)
- Follow `pint.json`/PSR-12; strict types if the codebase declares them.
- Validation in FormRequest, authorization in policies, business logic in services/actions per project pattern — not in controllers or Blade.
- Eloquent: eager-load relations used in loops; use resources/transformers for API output.
