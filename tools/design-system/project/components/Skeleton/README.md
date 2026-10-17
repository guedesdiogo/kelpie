# Skeleton

Loading shows nothing new for 200 ms, then a still skeleton in the final layout's shape, then the content in the same place (5.11, frequent grammar).

- **The first 200 ms show nothing new.** The old content stays.
- **A skeleton.** Past 200 ms, a skeleton in the final layout's shape replaces it, and stays at least 400 ms. It never shimmers: a loop that never stops is one of the rejected patterns.
- **The content** replaces the skeleton with a `dur-fade` fade in the same place, without moving the layout. A group announces itself once (`role="status"`).
- **Past 10 s,** the work becomes a background task with real progress, and the screen is free again.
- **The skeleton's blocks** are `sunken`, with the radii the content will have.
- **The consumer provides** the final layout's shape and the content.
- **Reduced motion:** the same, since it is all fades.
