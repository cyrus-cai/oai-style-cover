# oai-style-cover

Nine editorial cover styles, drawn with Canvas 2D. No image model, no dependencies, no build step.

https://oai-cover.vercel.app

[openai-editorial-cover](https://github.com/Niall-Young/openai-cover-skill) is a set of prompt rules written for GPT Image 2. This is the same nine styles and three aspect ratios written as code instead, so the same seed always gives you the same cover.

## Using it

Pick a cover, type a title, press space to reroll, D to save a PNG (5K on desktop). You can also drop in your own screenshot or logo.

## Running it

```bash
python3 -m http.server 8137
```

`engine.js` holds the nine renderers and the typesetting. `app.js` is the interface.

## License

MIT. The design language comes from [Niall-Young/openai-cover-skill](https://github.com/Niall-Young/openai-cover-skill) (MIT). Not affiliated with OpenAI.
