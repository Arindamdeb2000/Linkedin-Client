const nodeLinkedin = require('node-linkedin');

const oauth = require('./oauth');
const config = require('../config');
require('./utils/date_utils');
const linkedinApiFields = require('../assets/linkedin_api_fields.json');
const pup = require('./utils/pup_utils');

let linkedin;
let tokenExpirationDate;

module.exports = {
	init: init,
	getCompanyOrPeopleDetails: getCompanyOrPeopleDetails
};

async function init() {
	try {
		console.log('Initializing the Linkedin client...');
		const accessToken = await oauth.getAccessToken();
		tokenExpirationDate = new Date().addSeconds(accessToken['expires_in']);
		linkedin = nodeLinkedin(config.linkedinApiKey, config.linkedinApiSecret).init(accessToken['access_token']);
	} catch (e) {
		console.error(e);
		throw new Error('Initialization has failed.');
	}
}

// options = page, forcePeopleScraping, skipCompanyScraping
async function getCompanyOrPeopleDetails(linkedinUrl, options = {}) {
	if (new Date() > tokenExpirationDate) await init();

	console.log('Getting data from "' + linkedinUrl + '"...');
	let browser = null;
	let page = options.page;
	let peopleDetails = null;
	let linkedinApiInternalError = false;

	// if the provided URL is a people profile URL
	if (!isCompanyOrSchoolPage(linkedinUrl)) {
		if (options.forcePeopleScraping) {
			// force people profile scraping instead of using the API
			if (!page) {
				browser = await pup.runBrowser({headless: config.headless});
				page = await pup.createPage(browser, config.cookiesFile);
			}
			peopleDetails = await scrapPeopleProfile(page, linkedinUrl);
		} else {
			// get people data through API
			peopleDetails = await getPeopleData(linkedinUrl);
			if (peopleDetails['message']) {
				linkedinApiInternalError = peopleDetails['message'] == 'Internal API server error';
				if (!linkedinApiInternalError) return {error: peopleDetails['message']}; // the linkedin URL is invalid
			}

			// get people data through web scraper if the people profile is private
			peopleDetails['isPrivateProfile'] = peopleDetails['id'] == 'private';
			if (peopleDetails['isPrivateProfile'] || linkedinApiInternalError) {
				if (!page) {
					browser = await pup.runBrowser({headless: config.headless});
					page = await pup.createPage(browser, config.cookiesFile);
				}
				peopleDetails = await scrapPeopleProfile(page, linkedinUrl);
			}
		}

		// return if option for skipping company scraping is set
		if (options.skipCompanyScraping) {
			if (!options.page && browser) await browser.close();
			return peopleDetails;
		}

		// try to get the company page url for the next step
		const companyId =
			peopleDetails['positions']['values'] && peopleDetails['positions']['values'][0]['company']['id'];
		if (companyId) linkedinUrl = 'https://www.linkedin.com/company/' + companyId;
		else linkedinUrl = peopleDetails['currentCompany'] && peopleDetails['currentCompany']['linkedinUrl'];

		// return if company page url has not been found or if the URL is not a company page URL
		if (!linkedinUrl || !isCompanyOrSchoolPage(linkedinUrl)) {
			if (!options.page && browser) await browser.close();
			return peopleDetails;
		}
	}

	if (!page) {
		browser = await pup.runBrowser({headless: config.headless});
		page = await pup.createPage(browser, config.cookiesFile);
	}

	// scrap company data
	let companyDetails;
	try {
		companyDetails = await scrapCompanyPage(page, linkedinUrl);
	} catch (e) {
		// I was trying to understand why I cannot log in to Linkedin from my VPS server
		console.error(page.url());
		await page.screenshot({path: 'error.png'});
		throw e;
	}

	if (!options.page) await browser.close();

	if (peopleDetails) {
		peopleDetails['company'] = companyDetails;
		return peopleDetails;
	}
	return companyDetails;
}

async function getPeopleData(profileUrl) {
	return new Promise((resolve, reject) => {
		linkedin.people.url(profileUrl, linkedinApiFields, (err, user) => {
			if (err) reject(err);
			else resolve(user);
		});
	});
}

async function scrapPeopleProfile(page, url = null) {
	if (url) {
		await pup.goTo(page, url, {ignoreDestination: true});
		await logIn(page, config.linkedinEmail, config.linkedinPassword, {redirectionUrl: url});
	}
	await page.waitForSelector('section.pv-profile-section');
	const toggleButton = await page.$('pv-top-card-section__summary-toggle-button');
	if (toggleButton) await toggleButton.click();
	if (await page.$('span.pv-top-card-v2-section__company-name'))
		await pup.scrollPage(page, '#experience-section', 0.5);
	const peopleDetails = await page.evaluate(() => {
		const name = $('h1.pv-top-card-section__name')
			.text()
			.trim()
			.split(' ');
		const experiences = $('#experience-section li')
			.get()
			.map((elt) => {
				elt = $(elt);
				return {
					companyName: elt
						.find('span.pv-entity__secondary-title')
						.text()
						.trim(),
					linkedinUrl: 'https://www.linkedin.com' + elt.find('a.ember-view').attr('href')
				};
			});
		const relatedPeople = $('section.pv-browsemap-section li')
			.get()
			.map((elt) => {
				elt = $(elt);
				return {
					name: elt
						.find('span.actor-name')
						.text()
						.trim(),
					position: elt
						.find('p.browsemap-headline')
						.text()
						.trim(),
					linkedinUrl: 'https://www.linkedin.com' + elt.find('a.pv-browsemap-section__member').attr('href')
				};
			});
		return {
			firstName: name[0],
			lastName: name[1],
			headline: $('h2.pv-top-card-section__headline')
				.text()
				.trim(),
			location: $('h3.pv-top-card-section__location')
				.text()
				.trim(),
			summary: $('p.pv-top-card-section__summary-text')
				.text()
				.trim(),
			currentCompany: experiences.length ? experiences[0] : null,
			school:
				$('a.pv-top-card-v2-section__link-education span')
					.text()
					.trim() || null,
			connectionsNumber: parseInt(
				$('span.pv-top-card-v2-section__connections')
					.text()
					.match(/[0-9]+/)[0]
			),
			positions: experiences,
			relatedPeople: relatedPeople
		};
	});
	peopleDetails['linkedinUrl'] = page.url();
	return peopleDetails;
}

async function scrapCompanyPage(page, url = null) {
	if (url) {
		await pup.goTo(page, url, {ignoreDestination: true});
		await logIn(page, config.linkedinEmail, config.linkedinPassword, {redirectionUrl: url});
	}
	await page.waitFor('#org-about-company-module__show-details-btn');
	await page.click('#org-about-company-module__show-details-btn');
	await page.waitForSelector('div.org-about-company-module__about-us-extra');
	const companyDetails = await page.evaluate(() => {
		const companyDetails = {};
		companyDetails['name'] = $('h1.org-top-card-module__name')
			.text()
			.trim();
		companyDetails['industry'] = $('span.company-industries')
			.text()
			.trim();
		companyDetails['description'] =
			$('p.org-about-us-organization-description__text')
				.text()
				.trim() || null;
		companyDetails['website'] = $('a.org-about-us-company-module__website')
			.text()
			.trim();
		companyDetails['headquarters'] =
			$('p.org-about-company-module__headquarters')
				.text()
				.trim() || null;
		companyDetails['foundedYear'] = parseInt(
			$('p.org-about-company-module__founded')
				.text()
				.trim()
		);
		companyDetails['companyType'] =
			$('p.org-about-company-module__company-type')
				.text()
				.trim() || null;
		companyDetails['companySize'] = parseInt(
			$('p.org-about-company-module__company-staff-count-range')
				.text()
				.trim()
		);
		companyDetails['specialties'] =
			$('p.org-about-company-module__specialities')
				.text()
				.trim() || null;
		companyDetails['followers'] = parseInt(
			$('span.org-top-card-module__followers-count')
				.text()
				.replace('followers', '')
				.replace(',', '')
				.trim()
		);
		companyDetails['membersOnLinkedin'] = parseInt(
			$('a.snackbar-description-see-all-link')
				.text()
				.replace('See all', '')
				.replace('employees on LinkedIn', '')
				.replace(',', '')
				.trim()
		);
		return companyDetails;
	});
	companyDetails['linkedinUrl'] = page.url();
	return companyDetails;
}

function isCompanyOrSchoolPage(linkedinUrl) {
	return (
		linkedinUrl.indexOf('https://www.linkedin.com/company/') != -1 ||
		linkedinUrl.indexOf('https://www.linkedin.com/school/') != -1
	);
}

// method not working...
async function getCompanyData(companyId) {
	return new Promise((resolve, reject) => {
		linkedin.companies.company(companyId, (err, company) => {
			if (err) reject(err);
			else resolve(company);
		});
	});
}

async function logIn(page, login, password, options = {}) {
	let loginButton = await page.$('p.login > a, a[title="Sign in"]');
	if (loginButton) {
		console.log('Logging in...');
		await loginButton.click();
		try {
			await page.waitFor('#login-email', {timeout: 2000});
		} catch (e) {
			await page.waitForNavigation();
		}
		await page.waitFor(2000);
		await page.type('#login-email, #username', login);
		await page.type('#login-password, #password', password);
		await page.click('#login-submit, button[aria-label="Sign in"]');
		await page.waitForNavigation();
		await pup.saveCookies(page, config.cookiesFile);
		console.log('Logged in.');
	}

	if (options.redirectionUrl && page.url() != options.redirectionUrl)
		await pup.goTo(page, options.redirectionUrl, {ignoreDestination: true});
}
