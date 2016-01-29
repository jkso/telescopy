"use strict";
const Util = require("./Util");
const URL = require("url");
const FS = require("fs");
const mkdirp = require("mkdirp");
const mime = require("mime");
const TransformerHtml = require("./TransformHtml");
const TransformerCss = require("./TransformCss");
const async = require("async");
const CP = require("child_process");
const debug = require("debug")("tcopy-resource");
const Stream = require("stream");
const Path = require("path");
const MIME = require("mime");
const Crypto = require("crypto");

function Resource() {
	this.project = null;

	this.linkedUrl = '';
	this.canonicalUrl = '';
	this.redirectUrl = '';
	this.baseUrl = '';

	this.localPath = '';
	this.expectedLocalPath = '';	//from link on other resource
	this.tempFile = '';

	this.downloaded = false;
	this.parsedResources = new Set();
	this.remoteHeaders = null;
	this.mime = '';
	this.expectedMime = '';

	this.retries = 0;
}

/*
 * get the url that we should use as basis to make urls absolute
 * this is the url that we have opened
 */
Resource.prototype.getOpenUrl = function(){
	return this.redirectUrl ? this.redirectUrl : this.linkedUrl;
};

/**
 * used to make absolute urls, overridden from base-tag
 */
Resource.prototype.getBaseUrl = function() {
	return this.baseUrl ? this.baseUrl : this.getOpenUrl();
};

Resource.prototype.setRedirectUrl = function( url ){
	this.redirectUrl = url;
	if (this.project.linkRedirects) {
		this.addUrlToProject( url );
	}
};

Resource.prototype.setCanonicalUrl = function( url ){
	this.canonicalUrl = url;
	if (this.project.linkRedirects) {
		this.addUrlToProject( url );
	}
};

Resource.prototype.addUrlToProject = function( url ){
	this.project.getUrlObj(url).queued = true;
};

Resource.prototype.getUrls = function(){
	var u = [ this.linkedUrl ];
	if (this.redirectUrl) u.push( this.redirectUrl );
	if (this.canonicalUrl) u.push( this.canonicalUrl );
	return u;
};

/**
 * get the best possible url
 */
Resource.prototype.getOfficialUrl = function(){
	return this.canonicalUrl ? this.canonicalUrl
			: this.redirectUrl ? this.redirectUrl
			: this.linkedUrl;
};

Resource.prototype.process = function () {
	var ths = this;
	return Promise.resolve(ths.project.fetch( this.linkedUrl ))
	/*
	 * get headers
	 */
	.then(function(fetchStream){
		return new Promise(function(resolve, reject) {
			var timer;
			fetchStream.on("meta",function(meta){
				debug("meta",meta);
				ths.remoteHeaders = meta.responseHeaders;
				if (ths.linkedUrl !== meta.finalUrl) {
					ths.redirectUrl = meta.finalUrl;
					ths.setRedirectUrl( meta.finalUrl );
				}
				if (meta.status >= 400) {
					debug("WARN "+meta.status);
					reject(meta);
				} else {
					resolve(fetchStream);
				}
				clearTimeout( timer );
			});
			fetchStream.on("error",reject);
			timer = setTimeout(function(){
				fetchStream.emit("error","timeout");
				fetchStream.destroy();
			},ths.project.timeoutToHeaders);
		});
	})
	/*
	 * download or skip
	 */
	.then(function(fetchStream){
		if (ths.localPath && ths.project.skipExistingFiles) {	//we already have a local copy - NOT IMPLEMENTED YET
			return true;
		}
		return ths.download(fetchStream);
	})
	/*
	 * check if we need to proceed
	 */
	.then(function(){
		if (ths.localPath && ths.tempFile) {	// NOT IMPLEMENTED YET
			return ths.isTempFileDifferent();
		} else {
			return true;
		}
	})
	/*
	 * move file into position, link if neccessary, finish up
	 */
	.then(function(different){

		if (ths.project.linkRedirects) {
			let mime = ths.guessMime();
			if (ths.canonicalUrl && ths.canonicalUrl !== ths.linkedUrl) {
				let canonicalPath = ths.calculateLocalPathFromUrl( ths.canonicalUrl, mime );
				ths.project.createSymlink( canonicalPath, ths.getLocalPath() );
			}
			if (ths.redirectUrl && ths.redirectUrl !== ths.linkedUrl) {
				let redirPath = ths.calculateLocalPathFromUrl( ths.redirectUrl, mime );
				ths.project.createSymlink( redirPath, ths.getLocalPath() );
			}
		} //else the other urls are ignored and downloaded seperately if needed

		if (different) {
			ths.project.addResourceUrls( ths.parsedResources );
			return ths.overrideFromTmpFile();
		}
	});
};

Resource.prototype.download = function(fetchStream) {
	var ths = this;
	return new Promise(function(resolve, reject) {
		var timer;
		if (!ths.linkedUrl) {
			return reject("cannot download, no remote url");
		}
		if (!ths.tempFile) {
			ths.tempFile = ths.project.getTmpFileName();
		}
		var saveStream = FS.createWriteStream( ths.tempFile );
		var transformStream;
		var guessedMime = ths.guessMime();
		debug("guessed Mime: ",guessedMime);
		switch (guessedMime) {
			case 'html':
			case 'text/html':
				transformStream = new TransformerHtml( ths.updateHtmlAttributes.bind(ths) );
			break;

			case 'text/css':
				transformStream = new TransformerCss({
					onUrl : ths.updateCssUrl.bind(ths),
					onImport : ths.updateCssUrl.bind(ths)
				});
			break;

			default:
				transformStream = new Stream.PassThrough();
			break;
		}

		fetchStream
			.pipe( transformStream )
			.pipe( saveStream );

		transformStream.on("end", function(){
			clearTimeout(timer);
			resolve();
		});
		fetchStream.on("error",reject);
		fetchStream.resume();
		timer = setTimeout(function(){
			fetchStream.emit("error","timeout");
			fetchStream.destroy();
		},ths.project.timeoutToDownload);
	});
};

Resource.prototype.isTempFileDifferent = function () {
	var ths = this;new Promise(function(resolve, reject) {
		async.parallel([
			function(cb){
				let hash = new Crypto.Hash("sha1");
				FS.createReadStream( ths.localPath ).pipe(hash).on("end",cb);
			},
			function(cb){
				let hash = new Crypto.Hash("sha1");
				FS.createReadStream( ths.tempFile ).pipe(hash).on("end",cb);
			}
		],function(err,res){
			if (err) reject(err);
			else resolve( res[0] === res[1] );
		});
	});
};

Resource.prototype.overrideFromTmpFile = function(){
	var ths = this;
	return new Promise(function(resolve, reject) {
		async.series([
			function(cb){
				let dirname = Path.dirname( ths.getLocalPath() );
                mkdirp(dirname,cb);
			},
			function(cb){
                FS.rename( ths.tempFile, ths.getLocalPath(), cb );
			}
		],function(err){
			if (err) reject(err);
			else resolve();
		});
	});
};

Resource.prototype.updateHtmlAttributes = function (tag, attributes) {
	switch (tag) {
		case 'a':
			if (attributes.href) {
				attributes.href = this.processResourceLink( attributes.href, 'text/html' );
			}
		break;

		case 'link':
			if (attributes.rel === 'canonical' && attributes.href) {
				let absolute = this.makeUrlAbsolute( attributes.href );
				this.setCanonicalUrl( absolute );
				return false;	//delete it
			}
			if (attributes.rel === 'stylesheet' && attributes.href) {
				attributes.href = this.processResourceLink( attributes.href, 'text/css' );
			}
		break;

		case 'img':
			if (attributes.src) {
				attributes.src = this.processResourceLink( attributes.src, MIME.lookup(attributes.src) );
			}
		break;

		case 'script':
			if (attributes.src) {
				attributes.src = this.processResourceLink( attributes.src, 'application/javascript' );
			}
		break;

		case 'base':
			if (attributes.href) {
				this.baseUrl = attributes.href;
				return false;	//delete it
			}
		break;

		case 'form':
			if (attributes.action) {
				attributes.action = this.processResourceLink( attributes.action, 'text/html' );
			}
		break;

		case 'button':
			if (attributes.formaction) {
				attributes.formaction = this.processResourceLink( attributes.formaction, 'text/html' );
			}
		break;

		case 'meta':
			if (attributes['http-equiv'] === 'refresh' && attributes.content) {
				let ths = this;
				attributes.content.replace(/^(\d+);url=(.+)$/i,function(all,time,url){
					url = ths.processResourceLink( url, 'text/html' );
					return `${time};url=${url}`;
				});
			}
		break;
	}
	return attributes;
};

Resource.prototype.updateCssUrl = function (url) {
	let mime = MIME.lookup(url);
	return this.processResourceLink( url, mime );
};

/**
 * @param string url
 * @param string type
 * @return string local url
 **/
Resource.prototype.processResourceLink = function (url, type) {
	debug("processResourceLink",url,type);
	let absolute = this.makeUrlAbsolute( url );
	if (this.project.queryUrlFilter( absolute )) {
		let localFile = this.getLocalPath();
		let linkFile = this.calculateLocalPathFromUrl( absolute, type );
		let localUrl = this.calculateLocalUrl( linkFile, localFile );
		if (this.project.skipFile( linkFile ) === false) {
			this.parsedResources.add([ absolute, linkFile, type ]);
		}
		return localUrl;
	} else {
		return absolute;
	}
};

Resource.prototype.guessMime = function () {
	let fromUrl = mime.lookup( this.linkedUrl );
	let type = this.remoteHeaders ? this.remoteHeaders['content-type'] : null;
	if (type) {
		let cpos = type.indexOf(";");
		if (cpos) {
			type = type.substring(0,cpos);
		}
	}
	debug( "guessingMime", [this.expectedMime, fromUrl, type] );
	if (this.expectedMime) {
		let reg = new RegExp(this.expectedMime,"i");
		if (reg.test(fromUrl)) {
			return fromUrl;
		}
		if (reg.test(type)) {
			return type;
		}
		return this.expectedMime;
	}
	return type ? type : fromUrl;
};

Resource.prototype.makeUrlAbsolute = function( url ) {
	let baseUrl = this.getBaseUrl();
	debug("make absolute",baseUrl,url);
	return URL.resolve( baseUrl, url );
};

Resource.prototype.getLocalPath = function() {
	if (!this._localPath) {
		this._localPath = this.expectedLocalPath ? this.expectedLocalPath
				: this.calculateLocalPathFromUrl( this.linkedUrl, this.guessMime() );
	}
	return this._localPath;
};

/**
 * create an absolute local path based on the project and the absolute url
 */
Resource.prototype.calculateLocalPathFromUrl = function ( url, mime ) {
	let basePath = this.project.localPath;
	let parsedUrl = URL.parse( url, true, false );
	var queryString = '';
	if (parsedUrl.search) {	//add query as base64
		queryString = new Buffer(parsedUrl.search).toString("base64");
	}
	let ext = MIME.extension( mime );
	let ending = "." + (ext ? ext : 'html');
	let path = parsedUrl.pathname && parsedUrl.pathname.length > 1
				? parsedUrl.pathname : '/';
	if (path[path.length - 1] === '/') {
		path += this.project.defaultIndex;
	}
	let pathExt = Path.extname(path);
	if (pathExt) {
		path = path.substr(0, path.length - pathExt.length);
	}
	path += queryString;
	path += ending;
	let full = Path.join( basePath, parsedUrl.hostname, path);
	debug("calculated local path to be "+full);
	return full;
};

/**
 * create a relative url between two local files
 */
Resource.prototype.calculateLocalUrl = function ( link, base ) {
	let linkParsed = URL.parse( link, false, false );
	let baseParsed = URL.parse( base, false, false );
	let relPath = Path.relative( Path.dirname(baseParsed.path), Path.dirname(linkParsed.path) );
	let relLink = Path.join( relPath, Path.basename( linkParsed.path ) );
	let search = linkParsed.search ? linkParsed.search : '';
	let hash = linkParsed.hash ? linkParsed.hash : '';
	debug("calc localUrl from "+JSON.stringify([link,base,relLink]));
	return relLink + search + hash;
};

module.exports = Resource;