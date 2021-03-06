# TelesCOPY Docs

Module for mirroring websites. Created because using wget is awful to use from other programs and doesn't have precise enough URL filtering. This addresses the following issues:

* designed to integrate well into other node apps
* can also run from the CLI
* perfect URL filtering options
* able to cancel and still use what has been downloaded so far (local file names are deterministic)
* allows for re-download of single resources and update of whole mirrors

Some other features:

* fast (all streaming), but only one thread
* low memory overhead (50-90 MB even for huge sites)
* keeps stats of allowed and denied URLs and how often they appeared
* keeps track of downloaded bits and bps
* socks5 proxy support
* cli tool for testing filters

It is **not** a JS-aware scraper that uses phantomjs or similar tech.

## Documentation

 * [Configuration](config.md)
 * [Filters](filters.md)
 * [Html Attribute Parsing](html.md)
 * [Integration - API and Events](integration.md)
 * [Debugging](debugging.md)
 * [Development, known Limitations](todo.md)

## Quickstart

### Config

First setup a config file for your website project. It can be in .json or CommonJS require-able .js

```json
{
	"remote": "https://choosealicense.com/",
	"local" : "./Data/choosealicense.com"
}
```

When specifying functions, the CommonJS version is required:

```js
module.exports = {
	remote: "https://choosealicense.com/",
	local : "./Data/choosealicense.com",
	filterByUrl: (parsedUrl) => {
		//your filter logic
		return allowed;
	}
}
```

### CLI

Depending on where you saved your config, run the project like this:

```sh
node bin/run.sh Data/config.js
```

It will keep you up-to-date while it runs and exit the process once no more resources need to be downloaded.

### Integration

Telescopy is written to integrate well into bigger projects. For a more complete example check out the bin/run.js and the full documentation.

```js
const Telescopy = require("telescopy");
let project = new Telescopy({
	"remote": "https://choosealicense.com/",
	"local" : "./Data/choosealicense.com"
});
project.on("error",err => {
	//something unexpected happend
});
project.on("end",finished => {
	if (finished) //project complete
	//otherwise just paused
});
project.start();
```

### More examples

For more examples see the Tests-directory. For more in-depth examples of urlFiltering (the main part of the configuration), see [Filters](./filter.md).
