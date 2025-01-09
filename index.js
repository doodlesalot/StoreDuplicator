const Shopify = require('shopify-api-node');
require('dotenv').config()
const { program } = require('commander');
const Migrator = require('./src/migrator.js')
const dns = require('dns');

function checkDns(domain) {
  return new Promise((resolve, reject) => {
    dns.resolve(domain, (err, addresses) => {
      if (err) {
        console.error(`DNS resolution failed for ${domain}:`, err);
        reject(err);
      } else {
        console.log(`DNS resolution successful for ${domain}:`, addresses);
        resolve(addresses);
      }
    });
  });
}

program.version('1.0.0');
program
  .option('--all', 'Migrate everything')
  .option('--metafields', 'Run the migration for shop\'s metafields')
  .option('--delete-metafields', 'Delete(replace) shop metafields with the same namespace and key')
  .option('--products', 'Run the migration for products')
  .option('--delete-products', 'Delete(replace) products with the same handles')
  .option('--collections', 'Run the migration for collections')
  .option('--delete-collections', 'Delete(replace) collections with the same handles')
  .option('--articles', 'Run the migration for articles')
  .option('--delete-articles', 'Delete(replace) articles with the same handles')
  .option('--blogs', 'Run the migration for blogs')
  .option('--delete-blogs', 'Delete(replace) with the same handles')
  .option('--pages', 'Run the migration for pages')
  .option('--delete-pages', 'Delete(replace) pages with the same handles')
  .option('--files', 'Run the migration for files')
  .option('--delete-files', 'Delete(replace) files with the same names')
  .option('--menus', 'Run the migration for menus')
  .option('--delete-menus', 'Delete(replace) menus with the same handles')
  .option('--save-data', 'Save every source data as json files under a `data/{type}` folder. For example, `data/products/123456.json`')
  .option('-v, --verbosity', 'Verbosity level. Defaults to 4, as talkative as my MIL.')

program.parse(process.argv);

const start = async () => {
  const migration = new Migrator(null, null, (program.verbosity && program.verbosity * 1) || 4, program.saveData)
  try {
    await migration.testConnection()
    migration.log('Store configuration looks correct.')
  } catch (e) {
    migration.error('Could not validate proper store setup', e.message)
    process.exit()
  }
  try {
    if (program.all || program.pages) {
      await migration.migratePages(program.deletePages)
    }
    if (program.all || program.files) {
      await migration.migrateFiles(program.deleteFiles)
    }
    if (program.all || program.blogs) {
      await migration.migrateBlogs(program.deleteBlogs)
    }
    if (program.all || program.articles) {
      await migration.migrateArticles(program.deleteArticles)
    }
    if (program.all || program.products) {
      await migration.migrateProducts(program.deleteProducts)
    }
    if (program.all || program.collections) {
      await migration.migrateSmartCollections(program.deleteCollections)
      await migration.migrateCustomCollections(program.deleteCollections)
    }
    if (program.all || program.metafields) {
      await migration.migrateMetafields(program.deleteMetafields)
    }
    if (program.all || program.menus) {
      await migration.migrateMenus(program.deleteMenus)
    }
  } catch (e) {
    console.error(e);
    console.log(e.response)
  }
}
start()