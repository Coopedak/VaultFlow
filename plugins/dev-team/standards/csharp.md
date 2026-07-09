# Stack Standards: C# / .NET (Framework, Core, WPF)

Extends [`coding-standards.md`](coding-standards.md). Local code style still wins on §1.4 matters.

## Language & async
- `async Task` / `async Task<T>` for async methods — never `async void` except event handlers.
- Never `.Result`, `.Wait()`, or `.GetAwaiter().GetResult()` on async code in a context that can
  deadlock (UI thread, ASP.NET request thread). Await it.
- Honor the project's nullable-reference-type setting; don't flip `<Nullable>` to make a warning go away.
- Dispose `IDisposable` deterministically (`using`, or `Dispose()` in the owner's lifecycle).

## Structure & DI
- Match existing namespace and folder conventions exactly.
- Register new services in the project's DI container the same way siblings are registered; don't
  introduce a second container or service-locator pattern.
- Keep `.csproj` edits minimal — add only the package references the task needs, pinned to versions
  compatible with the project's target framework. Mind .NET Framework vs .NET 5+ package splits.

## WPF / MVVM
- ViewModels expose bindable properties with `INotifyPropertyChanged`; raise change notification on
  every property the XAML binds to.
- No code-behind business logic — it belongs in the ViewModel.
- Long-running work goes off the UI thread; marshal back with the dispatcher, not by blocking.
- Commands via the project's existing `ICommand` pattern (RelayCommand/DelegateCommand) — don't add a new one.

## Reviewer hot-spots
`async void`, blocking-on-async, undisposed `IDisposable`, missing change notification on bound
properties, LINQ that materializes (`.ToList()`) when it needn't, swallowed exceptions, and string
concatenation into SQL.
