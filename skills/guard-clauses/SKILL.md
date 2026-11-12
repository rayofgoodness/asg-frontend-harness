---
name: guard-clauses
description: Guard clause (early return) style for new and edited JS/TS/Vue code in task-harness runs. Used by the implementer when writing code and by the conventions reviewer when checking the diff.
---

Applies to code you write or change in this task: new functions, and the lines you edit in existing ones. It is not a reason to restructure code the task does not touch.

A documented project rule that says otherwise (`CLAUDE.md`, `.claude/rules/**`, an ESLint rule) wins.

## Rules

1. **Check invalid states first and leave.** Missing input, wrong state, nothing to do: test it at the top of the function and `return` / `throw` at once.
2. **Happy path at the lowest indentation.** The main work of the function is not wrapped in an `if`.
3. **No `else` after `return`, `throw`, `continue` or `break`.** The code after the `if` already is the else branch.
4. **Nesting depth at most 2** inside a function (an `if` in a loop is fine; an `if` in an `if` in a loop is not). Deeper logic becomes an early exit or its own function.
5. **No lone `if` inside `else`.** Use `else if`, or better an early return.
6. **Braces on every multi-line branch.** A one-line guard may stay on one line: `if (!user) return`.

In loops the guard is `continue`:

```ts
for (const item of items) {
    if (!item.isActive) continue
    if (item.stock === 0) continue
    addToFeed(item)
}
```

## Example

Instead of:

```ts
async function addToCart(product: Product | null, quantity: number) {
    if (product) {
        if (quantity > 0) {
            if (product.stock >= quantity) {
                await cartStore.add(product.id, quantity)
                return true
            } else {
                showError('notEnoughStock')
                return false
            }
        } else {
            return false
        }
    } else {
        return false
    }
}
```

write:

```ts
async function addToCart(product: Product | null, quantity: number) {
    if (!product) return false
    if (quantity <= 0) return false
    if (product.stock < quantity) {
        showError('notEnoughStock')
        return false
    }

    await cartStore.add(product.id, quantity)
    return true
}
```

## Vue specifics

- The same rules apply inside `<script setup>` functions, composables, store actions, watchers and event handlers.
- `computed` and `watch` callbacks: guard first, then the value or the effect.

  ```ts
  const total = computed(() => {
      if (!cart.value) return 0
      return cart.value.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  })
  ```
- Templates are out of scope: `v-if` / `v-else` chains are fine. If a template condition grows past two levels, move it to a `computed`.

## When editing existing code

- A function you add or rewrite: follows all rules.
- A few lines changed inside an old nested function: write your lines in this style where the surrounding structure allows it, and do not unwrap the rest of the function. Restructuring untouched branches is a scope deviation.
- Never keep behaviour-changing "cleanups": turning a nested `if` into guards must not change which branch runs, what is returned, or the order of side effects.

## For the reviewer

Check added and changed lines only. Report as `rule: "guard-clauses"`, `source: "task-harness guard-clauses skill"`:

- `else` after `return`/`throw`/`continue`/`break` in new code — major;
- a new function with nesting deeper than 2, or with the main path wrapped in an `if` that could be an early exit — major;
- a lone `if` inside a new `else`, a multi-line branch without braces — minor.

Do not report code that was already nested before the change and was only touched on a few lines.
