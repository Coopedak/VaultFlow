# Stack Standards: TypeScript Web (Angular, Vue, React)

Extends [`coding-standards.md`](coding-standards.md). Local code style still wins on §1.4 matters.

## TypeScript (all frameworks)
- Type safety is a feature. Avoid `any`; prefer real types and inference. `as` casts hide bugs —
  use them only when you can justify why the type system can't see what you can.
- No floating promises — `await` them or explicitly handle them.
- Match the project's module, import-ordering, and path-alias conventions.

## Angular
- CLI naming: `kebab-case.component.ts`, `.service.ts`, `.module.ts`.
- Prefer built-ins (HttpClient, RxJS, CDK, signals) over third-party replacements already covered.
- Unsubscribe from observables (takeUntil, async pipe, or DestroyRef) — leaked subscriptions are a defect.
- Respect the existing module/standalone-component decision; don't dump everything in AppModule.

## Vue
- Match the project's Composition API vs Options API choice — don't mix styles in one component.
- Use the project's store (Pinia / Vuex / composables); don't introduce a second one.
- Respect reactivity rules — don't mutate props; use reactive/ref correctly so Vue tracks changes.

## React
- Functional components with hooks unless the project uses class components.
- Correct `useEffect` dependency arrays; no state updates during render.
- Use the project's state pattern (Context / Redux / Zustand) and CSS approach (modules /
  styled-components / Tailwind) — whatever is already in use.

## Reviewer hot-spots
`any` leaks, floating promises, leaked subscriptions (Angular), reactivity mistakes (Vue), missing
or wrong `useEffect` deps and stale closures (React), and introducing a parallel state/store/styling
system the project doesn't already use.
