const Shopify = require('shopify-api-node');
const fs = require('fs');
const fetch = require('node-fetch');
require('dotenv').config();

class Migrator {
  constructor(sourceStore, destinationStore, verbosity = 4, saveData) {
    this.config = {
      source: sourceStore,
      destination: destinationStore
    }
    this.saveData = !!saveData
    this.verbosity = verbosity
    this.source = new Shopify({
      shopName: process.env.SOURCE_SHOPIFY_STORE,
      accessToken: process.env.SOURCE_SHOPIFY_API_PASSWORD,
      apiVersion: '2023-10'
    });
    this.destination = new Shopify({
      shopName: process.env.DESTINATION_SHOPIFY_STORE,
      accessToken: process.env.DESTINATION_SHOPIFY_API_PASSWORD,
      apiVersion: '2023-10'
    });

    // Add GraphQL method to Shopify clients
    this.source.graphql = async (query, variables = {}) => {
      console.log(`Attempting to connect to: https://${process.env.SOURCE_SHOPIFY_STORE}/admin/api/2023-10/graphql.json`);
      const response = await fetch(`https://${process.env.SOURCE_SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SOURCE_SHOPIFY_API_PASSWORD,
        },
        body: JSON.stringify({ query, variables }),
      });
      return response.json();
    };

    this.destination.graphql = async (query, variables = {}) => {
      console.log(`Attempting to connect to: https://${process.env.DESTINATION_SHOPIFY_STORE}/admin/api/2023-10/graphql.json`);
      const response = await fetch(`https://${process.env.DESTINATION_SHOPIFY_STORE}/admin/api/2023-10/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.DESTINATION_SHOPIFY_API_PASSWORD,
        },
        body: JSON.stringify({ query, variables }),
      });
      return response.json();
    };

    if (this.saveData) {
      const types = ['products', 'pages', 'metafields', 'collections', 'articles', 'blogs', 'files']
      types.forEach(type => {
        const dir = `data/${type}`
        if (fs.existsSync(dir)) {
          return
        }
        try {
          fs.mkdirSync(dir, { recursive: true})
        } catch (e) {
          this.error(`Could not adequately create folder ${dir}`)
        }
      })
    }
    this.requiredScopes = {
      source: [
        ['read_content', 'write_content'],
        ['read_products', 'write_products'],
        ['read_files', 'write_files'],
        ['read_themes', 'write_themes'],
      ],
      destination: [
        ['write_content'],
        ['write_products'],
        ['write_files'],
        ['write_themes'],
      ]
    };
  }

  log(message) {
    if (this.verbosity >= 4) {
      console.log(message);
    }
  }

  info(message) {
    if (this.verbosity >= 3) {
      console.info(message);
    }
  }

  warn(message) {
    if (this.verbosity >= 2) {
      console.warn(message);
    }
  }

  error(message) {
    if (this.verbosity >= 1) {
      console.error(message);
    }
  }

  async asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }

  async testConnection() {
    const query = `
      query {
        shop {
          name
        }
      }
    `;

    try {
      const sourceResponse = await this.source.graphql(query);
      if (sourceResponse.data && sourceResponse.data.shop) {
        this.log(`Successfully connected to source store: ${sourceResponse.data.shop.name}`);
      } else {
        throw new Error('Could not connect to source store');
      }

      const destinationResponse = await this.destination.graphql(query);
      if (destinationResponse.data && destinationResponse.data.shop) {
        this.log(`Successfully connected to destination store: ${destinationResponse.data.shop.name}`);
      } else {
        throw new Error('Could not connect to destination store');
      }

    } catch (error) {
      this.error('Could not validate proper store setup');
      this.error(error.message);
      throw error;
    }
  }

  async migrateFiles(deleteFirst = false, skipExisting = true) {
    this.log('File migration started...')
    const destinationFiles = {}

    // Fetch files from the destination store
    let hasNextPage = true
    let cursor = null
    while (hasNextPage) {
      const query = `
        query {
          files(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                id
                createdAt
                alt
                ... on MediaImage {
                  id
                  image {
                    originalSrc
                  }
                }
                ... on GenericFile {
                  id
                  url
                  fileStatus
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `
      const response = await this.destination.graphql(query)
      if (response.errors) {
        this.error('GraphQL Error:', response.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      }
      if (!response.data || !response.data.files) {
        this.error('Invalid GraphQL response:', response);
        throw new Error('Invalid GraphQL response structure');
      }
      const files = response.data.files.edges.map(edge => edge.node)
      files.forEach(file => {
        const fileUrl = file.__typename === 'GenericFile' ? file.url : 
                       file.__typename === 'MediaImage' && file.image ? file.image.originalSrc : null;
        if (fileUrl) {
          destinationFiles[fileUrl] = file;
        }
      })
      hasNextPage = response.data.files.pageInfo.hasNextPage
      cursor = response.data.files.pageInfo.endCursor
    }

    // Fetch and migrate files from the source store
    hasNextPage = true
    cursor = null
    while (hasNextPage) {
      const query = `
        query {
          files(first: 250${cursor ? `, after: "${cursor}"` : ''}) {
            edges {
              node {
                id
                createdAt
                alt
                __typename
                ... on MediaImage {
                  id
                  image {
                    originalSrc
                  }
                }
                ... on GenericFile {
                  id
                  url
                  fileStatus
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `
      const response = await this.source.graphql(query)
      if (response.errors) {
        this.error('GraphQL Error:', response.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      }
      if (!response.data || !response.data.files) {
        this.error('Invalid GraphQL response:', response);
        throw new Error('Invalid GraphQL response structure');
      }
      const files = response.data.files.edges.map(edge => edge.node)
      await this.asyncForEach(files, async (file) => {
        this.saveData && fs.writeFileSync(`data/files/${file.id}.json`, JSON.stringify(file))

        const fileUrl = file.__typename === 'GenericFile' ? file.url :
                       file.__typename === 'MediaImage' && file.image ? file.image.originalSrc : null;

        if (!fileUrl) {
          this.warn(`[FILE ${file.id}] Skipping file with no URL`);
          this.warn(`File details: ${JSON.stringify(file, null, 2)}`);
          return;
        }

        if (destinationFiles[fileUrl] && deleteFirst) {
          this.log(`[DUPLICATE FILE] Deleting destination file ${fileUrl}`)
          await this._deleteFile(destinationFiles[fileUrl].id)
        }
        if (destinationFiles[fileUrl] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING FILE] Skipping ${fileUrl}`)
          return
        }
        await this._migrateFile(file)
      })
      hasNextPage = response.data.files.pageInfo.hasNextPage
      cursor = response.data.files.pageInfo.endCursor
    }

    this.log('File migration finished!')
  }

  async _migrateFile(file) {
    const fileUrl = file.__typename === 'GenericFile' ? file.url :
                   file.__typename === 'MediaImage' && file.image ? file.image.originalSrc : null;

    if (!fileUrl) {
      throw new Error(`[FILE ${file.id}] No URL available for file`);
    }

    this.info(`[FILE ${file.id}] ${fileUrl} started...`)
    const mutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            createdAt
            alt
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    const variables = {
      files: [{
        originalSource: fileUrl,
        alt: file.alt
      }]
    }
    const response = await this.destination.graphql(mutation, variables)
    if (response.data.fileCreate.userErrors.length > 0) {
      throw new Error(`[FILE ${file.id}] Failed to create: ${response.data.fileCreate.userErrors[0].message}`)
    } else {
      this.info(`[FILE ${file.id}] duplicated. New id is ${response.data.fileCreate.files[0].id}.`)
    }
  }

  async _deleteFile(fileId) {
    const mutation = `
      mutation fileDelete($fileId: ID!) {
        fileDelete(id: $fileId) {
          deletedFileId
          userErrors {
            field
            message
          }
        }
      }
    `
    const variables = {
      fileId: fileId
    }
    const response = await this.destination.graphql(mutation, variables)
    if (response.data.fileDelete.userErrors.length > 0) {
      this.error(`Failed to delete file ${fileId}: ${response.data.fileDelete.userErrors[0].message}`)
    }
  }

  async _getMetafields(resource = null, id = null) {
    let params = { limit: 250 }
    if (resource && id) {
      params.metafield = {
        owner_resource: resource,
        owner_id: id
      }
    }
    const metafields = []
    do {
      const resourceMetafields = await this.source.metafield.list(params)
      resourceMetafields.forEach(m => metafields.push(m))
      params = resourceMetafields.nextPageParameters;
    } while (params !== undefined);
    return metafields
  }
  async _migratePage(page) {
    this.info(`[PAGE ${page.id}] ${page.handle} started...`)
    const metafields = await this._getMetafields('page', page.id)
    this.info(`[PAGE ${page.id}] has ${metafields.length} metafields...`)
    const newPage = await this.destination.page.create(page)
    this.info(`[PAGE ${page.id}] duplicated. New id is ${newPage.id}.`)
    await this.asyncForEach(metafields, async (metafield) => {
      delete metafield.id
      metafield.owner_resource = 'page'
      metafield.owner_id = newPage.id
      this.info(`[PAGE ${page.id}] Metafield ${metafield.namespace}.${metafield.key} started`)
      await this.destination.metafield.create(metafield)
      this.info(`[PAGE ${page.id}] Metafield ${metafield.namespace}.${metafield.key} done!`)
    })
  }

  async _migrateBlog(blog) {
    this.info(`[BLOG ${blog.id}] ${blog.handle} started...`)
    const metafields = await this._getMetafields('blog', blog.id)
    this.info(`[BLOG ${blog.id}] has ${metafields.length} metafields...`)
    const newBlog = await this.destination.blog.create(blog)
    this.info(`[BLOG ${blog.id}] duplicated. New id is ${newBlog.id}.`)
    await this.asyncForEach(metafields, async (metafield) => {
      delete metafield.id
      metafield.owner_resource = 'blog'
      metafield.owner_id = newBlog.id
      this.info(`[BLOG ${blog.id}] Metafield ${metafield.namespace}.${metafield.key} started`)
      await this.destination.metafield.create(metafield)
      this.info(`[BLOG ${blog.id}] Metafield ${metafield.namespace}.${metafield.key} done!`)
    })
  }

  async _migrateSmartCollection(collection) {
    this.info(`[SMART COLLECTION ${collection.id}] ${collection.handle} started...`)
    const metafields = await this._getMetafields('smart_collection', collection.id)
    this.info(`[SMART COLLECTION ${collection.id}] has ${metafields.length} metafields...`)
    delete collection.publications
    const newCollection = await this.destination.smartCollection.create(collection)
    this.info(`[SMART COLLECTION ${collection.id}] duplicated. New id is ${newCollection.id}.`)
    await this.asyncForEach(metafields, async (metafield) => {
      delete metafield.id
      metafield.owner_resource = 'smart_collection'
      metafield.owner_id = newCollection.id
      this.info(`[SMART COLLECTION ${collection.id}] Metafield ${metafield.namespace}.${metafield.key} started`)
      await this.destination.metafield.create(metafield)
      this.info(`[SMART COLLECTION ${collection.id}] Metafield ${metafield.namespace}.${metafield.key} done!`)
    })
  }

  async _migrateCustomCollection(collection, productMap = {}) {
    this.info(`[CUSTOM COLLECTION ${collection.id}] ${collection.handle} started...`)
    const metafields = await this._getMetafields('custom_collection', collection.id)
    const products = []
    let params = { limit: 250 }
    do {
      const sourceProducts = await this.source.collection.products(collection.id, params)
      sourceProducts.forEach(p => products.push(p))
      params = sourceProducts.nextPageParameters;
    } while (params !== undefined);
    this.info(`[CUSTOM COLLECTION ${collection.id}] has ${products.length} products...`)
    this.info(`[CUSTOM COLLECTION ${collection.id}] has ${metafields.length} metafields...`)
    delete collection.publications
    collection.collects = products.map(p => productMap[p.id] || null).filter(p => p).map((p) => {
      return {
        product_id: p
      }
    })
    const newCollection = await this.destination.customCollection.create(collection)
    this.info(`[CUSTOM COLLECTION ${collection.id}] duplicated. New id is ${newCollection.id}.`)
    await this.asyncForEach(metafields, async (metafield) => {
      delete metafield.id
      metafield.owner_resource = 'custom_collection'
      metafield.owner_id = newCollection.id
      this.info(`[CUSTOM COLLECTION ${collection.id}] Metafield ${metafield.namespace}.${metafield.key} started`)
      await this.destination.metafield.create(metafield)
      this.info(`[CUSTOM COLLECTION ${collection.id}] Metafield ${metafield.namespace}.${metafield.key} done!`)
    })
  }

  async _migrateProduct(product) {
    this.info(`[PRODUCT ${product.id}] ${product.handle} started...`)
    const metafields = await (await this._getMetafields('product', product.id)).filter(m => m.namespace.indexOf('app--') !== 0)
    this.info(`[PRODUCT ${product.id}] has ${metafields.length} metafields...`)
    product.metafields = metafields.filter(v => v && v.value && v.value.indexOf && v.value.indexOf('gid://shopify/') === -1).filter(v => v.namespace.indexOf('app--') !== 0);
    const images = (product.images || []).map(v => v)
    delete product.images;
    (product.variants || []).forEach((variant, i) => {
      if (variant.compare_at_price && (variant.compare_at_price * 1) <= (variant.price * 1)) {
        delete product.variants[i].compare_at_price
      }
      /*reset fulfillment services to shopify*/
      delete variant.fulfillment_service
      variant.inventory_management = 'shopify'
      delete product.variants[i].image_id
    })
    if (product.metafields) {
      product.metafields = product.metafields.filter(m => m.namespace.indexOf('app--') !== 0)
    }
    const newProduct = await this.destination.product.create(product)
    this.info(`[PRODUCT ${product.id}] duplicated. New id is ${newProduct.id}.`)
    this.info(`[PRODUCT ${product.id}] Creating ${images && images.length || 0} images...`)
    if (images && images.length) {
      const newImages = images.map((image) => {
        image.product_id = newProduct.id
        image.variant_ids = image.variant_ids.map((oldId) => {
          const oldVariant = product.variants.find(v => v.id === oldId)
          const newVariant = newProduct.variants.find(v => v.title === oldVariant.title)
          return newVariant.id
        })
        return image
      })
      await this.asyncForEach(newImages, async (image) => {
        try {
          await this.destination.productImage.create(newProduct.id, image)
        } catch (e) {
          this.warn(e.message, 'Retrying.')
          await this.destination.productImage.create(newProduct.id, image)
        }
      })
    }
  }

  async _migrateArticle(blogId, article) {
    this.info(`[ARTICLE ${article.id}] ${article.handle} started...`)
    const metafields = await this._getMetafields('article', article.id)
    this.info(`[ARTICLE ${article.id}] has ${metafields.length} metafields...`)
    delete article.user_id
    delete article.created_at
    delete article.deleted_at
    article.published_at = article.created_at
    article.blog_id = blogId
    const newArticle = await this.destination.article.create(blogId, article)
    this.info(`[ARTICLE ${article.id}] duplicated. New id is ${newArticle.id}.`)
    await this.asyncForEach(metafields, async (metafield) => {
      delete metafield.id
      metafield.owner_resource = 'article'
      metafield.owner_id = newArticle.id
      this.info(`[ARTICLE ${article.id}] Metafield ${metafield.namespace}.${metafield.key} started`)
      await this.destination.metafield.create(metafield)
      this.info(`[ARTICLE ${article.id}] Metafield ${metafield.namespace}.${metafield.key} done!`)
    })
  }

  async migratePages(deleteFirst = false, skipExisting = true) {
    this.log('Page migration started...')
    let params = { limit: 250 }
    const destinationPages = {}
    do {
      const pages = await this.destination.page.list(params)
      await this.asyncForEach(pages, async (page) => {
        destinationPages[page.handle] = page.id
      })
      params = pages.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }
    do {
      const pages = await this.source.page.list(params)
      await this.asyncForEach(pages, async (page) => {
        this.saveData && fs.writeFileSync(`data/pages/${page.id}.json`, JSON.stringify(page));

        if (destinationPages[page.handle] && deleteFirst) {
          this.log(`[DUPLICATE PAGE] Deleting destination page ${page.handle}`)
          await this.destination.page.delete(destinationPages[page.handle])
        }
        if (destinationPages[page.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING PAGE] Skipping ${page.handle}`)
          return
        }
        await this._migratePage(page)
      })
      params = pages.nextPageParameters;
    } while (params !== undefined);
    this.log('Page migration finished!')
  }

  async migrateProducts(deleteFirst = false, skipExisting = true) {
    this.log('Product migration started...')
    let params = { limit: 250 }
    const destinationProducts = {}
    do {
      const products = await this.destination.product.list(params)
      await this.asyncForEach(products, async (product) => {
        destinationProducts[product.handle] = product.id
      })
      params = products.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }
    do {
      const products = await this.source.product.list(params)
      await this.asyncForEach(products, async (product) => {
        if (destinationProducts[product.handle] && deleteFirst) {
          this.log(`[DUPLICATE PRODUCT] Deleting destination product ${product.handle}`)
          await this.destination.product.delete(destinationProducts[product.handle])
        }
        if (destinationProducts[product.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING PRODUCT] Skipping ${product.handle}`)
          return
        }
        try {
          this.saveData && fs.writeFileSync(`data/products/${product.id}.json`, JSON.stringify(product));
          await this._migrateProduct(product)
        } catch (e) {
          this.error(`[PRODUCT] ${product.handle} FAILED TO BE CREATED PROPERLY.`,e, e.response, product.metafields)
        }
      }, 15)
      params = products.nextPageParameters;
    } while (params !== undefined);
    this.log('Product migration finished!')
  }
  async migrateMetafields(deleteFirst = false, skipExisting = true) {
    this.log('Shop Metafields migration started...')
    const sourceMetafields = []
    const destinationMetafields = []
    let params = { limit: 250 }
    do {
      const metafields = await this.source.metafield.list(params)
      metafields.forEach(m => sourceMetafields.push(m))
      params = metafields.nextPageParameters;
    } while (params !== undefined);

    params = { limit: 250 }
    do {
      const metafields = await this.destination.metafield.list(params)
      metafields.forEach(m => destinationMetafields.push(m))
      params = metafields.nextPageParameters;
    } while (params !== undefined);
    await this.asyncForEach(sourceMetafields, async (metafield) => {
      this.saveData && fs.writeFileSync(`data/metafields/${metafield.id}.json`, JSON.stringify(metafield));
      const destinationMetafield = destinationMetafields.find(f => f.key === metafield.key && f.namespace === metafield.namespace)
      if (destinationMetafield && deleteFirst) {
        this.log(`[DUPLICATE METAFIELD] Deleting destination metafield ${metafield.namespace}.${metafield.key}`)
        await this.destination.metafield.delete(destinationMetafield.id)
      }
      if (destinationMetafield && skipExisting && !deleteFirst) {
        this.log(`[EXISTING METAFIELD] Skipping ${metafield.namespace}.${metafield.key}`)
        return
      }
      try {
        delete metafield.owner_id
        delete metafield.owner_resource
        await this.destination.metafield.create(metafield)
      } catch (e) {
        this.error(`[METAFIELD] ${metafield.namespace}.${metafield.key} FAILED TO BE CREATED PROPERLY.`)
      }
    })
    this.log('Shop Metafields migration finished!')
  }

  async migrateSmartCollections(deleteFirst = false, skipExisting = true) {
    this.log('Smart Collections migration started...')
    let params = { limit: 250 }
    const destinationCollections = {}
    do {
      const collections = await this.destination.smartCollection.list(params)
      await this.asyncForEach(collections, async (collection) => {
        destinationCollections[collection.handle] = collection.id
      })
      params = collections.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }
    do {
      const collections = await this.source.smartCollection.list(params)
      await this.asyncForEach(collections, async (collection) => {
        this.saveData && fs.writeFileSync(`data/collections/${collection.id}.json`, JSON.stringify(collection));
        if (destinationCollections[collection.handle] && deleteFirst) {
          this.log(`[DUPLICATE COLLECTION] Deleting destination collection ${collection.handle}`)
          await this.destination.smartCollection.delete(destinationCollections[collection.handle])
        }
        if (destinationCollections[collection.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING COLLECTION] Skipping ${collection.handle}`)
          return
        }
        try {
          await this._migrateSmartCollection(collection)
        } catch (e) {
          this.error(`[COLLECTION] ${collection.handle} FAILED TO BE CREATED PROPERLY.`)
        }
      })
      params = collections.nextPageParameters;
    } while (params !== undefined);
    this.log('Smart Collection migration finished!')
  }

  async migrateCustomCollections(deleteFirst = false, skipExisting = true) {
    this.log('Custom Collections migration started...')
    let params = { limit: 250 }
    const destinationCollections = {}
    const productMap = {}
    const sourceProducts = []
    const destinationProducts = []

    do {
      const products = await this.source.product.list(params)
      products.forEach(p => sourceProducts.push(p))
      params = products.nextPageParameters;
    } while (params !== undefined);

    params = { limit: 250 }
    do {
      const products = await this.destination.product.list(params)
      products.forEach(p => destinationProducts.push(p))
      params = products.nextPageParameters;
    } while (params !== undefined);

    destinationProducts.forEach(p => {
      const sourceProduct = sourceProducts.find(s => s.handle === p.handle)
      if (sourceProduct) {
        productMap[sourceProduct.id] = p.id
      }
    })

    params = { limit: 250 }
    do {
      const collections = await this.destination.smartCollection.list(params)
      await this.asyncForEach(collections, async (collection) => {
        destinationCollections[collection.handle] = collection.id
      })
      params = collections.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }


    do {
      const collections = await this.destination.customCollection.list(params)
      await this.asyncForEach(collections, async (collection) => {
        destinationCollections[collection.handle] = collection.id
      })
      params = collections.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }
    do {
      const collections = await this.source.customCollection.list(params)
      await this.asyncForEach(collections, async (collection) => {
        this.saveData && fs.writeFileSync(`data/collections/${collection.id}.json`, JSON.stringify(collection));
        if (destinationCollections[collection.handle] && deleteFirst) {
          this.log(`[DUPLICATE COLLECTION] Deleting destination collection ${collection.handle}`)
          await this.destination.customCollection.delete(destinationCollections[collection.handle])
        }
        if (destinationCollections[collection.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING COLLECTION] Skipping ${collection.handle}`)
          return
        }
        try {
          await this._migrateCustomCollection(collection, productMap)
        } catch (e) {
          this.error(`[COLLECTION] ${collection.handle} FAILED TO BE CREATED PROPERLY.`, e)
        }
      })
      params = collections.nextPageParameters;
    } while (params !== undefined);
    this.log('Custom Collection migration finished!')
  }

  async migrateBlogs(deleteFirst = false, skipExisting = true) {
    this.log('Blog migration started...')
    let params = { limit: 250 }
    const destinationBlogs = {}
    do {
      const blogs = await this.destination.blog.list(params)
      await this.asyncForEach(blogs, async (blog) => {
        destinationBlogs[blog.handle] = blog.id
      })
      params = blogs.nextPageParameters;
    } while (params !== undefined);
    params = { limit: 250 }
    do {
      const blogs = await this.source.blog.list(params)
      await this.asyncForEach(blogs, async (blog) => {
        this.saveData && fs.writeFileSync(`data/blogs/${blog.id}.json`, JSON.stringify(blog));

        if (destinationBlogs[blog.handle] && deleteFirst) {
          this.log(`[DUPLICATE blog] Deleting destination blog ${blog.handle}`)
          await this.destination.blog.delete(destinationBlogs[blog.handle])
        }
        if (destinationBlogs[blog.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING BLOG] Skipping ${blog.handle}`)
          return
        }
        await this._migrateBlog(blog)
      })
      params = blogs.nextPageParameters;
    } while (params !== undefined);
    this.log('Blog migration finished!')
  }

  async migrateArticles(deleteFirst = false, skipExisting = true) {
    const blogParams = {limit: 250}
    const sourceBlogs = await this.source.blog.list(blogParams)
    const destinationBlogs = await this.destination.blog.list(blogParams)
    const matchingBlogs = sourceBlogs.filter((sourceBlog) => {
      return destinationBlogs.find(destinationBlog => destinationBlog.handle === sourceBlog.handle)
    })
    this.log(`Migrating articles for ${matchingBlogs.length} matching blog(s): ${matchingBlogs.map(b => b.handle).join(', ')}`)

    this.asyncForEach(matchingBlogs, async (blog) => {
      const destinationBlog = destinationBlogs.find(b => b.handle === blog.handle)
      let params = { limit: 250 }
      const destinationArticles = {}
      do {
        const articles = await this.destination.article.list(destinationBlog.id, params)
        await this.asyncForEach(articles, async (article) => {
          destinationArticles[article.handle] = article.id
        })
        params = articles.nextPageParameters;
      } while (params !== undefined);

      params = { limit: 250 }
      do {
        const articles = await this.source.article.list(blog.id, params)
        await this.asyncForEach(articles, async (article) => {
          this.saveData && fs.writeFileSync(`data/articles/${article.id}.json`, JSON.stringify(article));
          if (destinationArticles[article.handle] && deleteFirst) {
            this.log(`[DUPLICATE article] Deleting destination article ${article.handle}`)
            await this.destination.article.delete(destinationBlog.id, destinationArticles[article.handle])
          }
          if (destinationArticles[article.handle] && skipExisting && !deleteFirst) {
            this.log(`[EXISTING ARTICLE] Skipping ${article.handle}`)
            return
          }
          await this._migrateArticle(destinationBlog.id, article)
        })
        params = articles.nextPageParameters;
      } while (params !== undefined);
    })
  }
  async migrateMenus(deleteFirst = false, skipExisting = true) {
    this.log('Menu migration started...')
    const destinationMenus = {}

    // Fetch menus from the destination store
    const destinationQuery = `
      query {
        menus(first: 250) {
          edges {
            node {
              id
              handle
              title
              items {
                id
                title
                url
                type
              }
            }
          }
        }
      }
    `
    const destinationResponse = await this.destination.graphql(destinationQuery)
    if (destinationResponse.data && destinationResponse.data.menus) {
      destinationResponse.data.menus.edges.forEach(edge => {
        destinationMenus[edge.node.handle] = edge.node
      })
    }

    // Fetch and migrate menus from the source store
    const sourceQuery = `
      query {
        menus(first: 250) {
          edges {
            node {
              id
              handle
              title
              items {
                id
                title
                url
                type
              }
            }
          }
        }
      }
    `
    const sourceResponse = await this.source.graphql(sourceQuery)
    if (sourceResponse.data && sourceResponse.data.menus) {
      await this.asyncForEach(sourceResponse.data.menus.edges, async (edge) => {
        const menu = edge.node
        this.saveData && fs.writeFileSync(`data/menus/${menu.id}.json`, JSON.stringify(menu))

        if (destinationMenus[menu.handle] && deleteFirst) {
          this.log(`[DUPLICATE MENU] Deleting destination menu ${menu.handle}`)
          await this._deleteMenu(destinationMenus[menu.handle].id)
        }
        if (destinationMenus[menu.handle] && skipExisting && !deleteFirst) {
          this.log(`[EXISTING MENU] Skipping ${menu.handle}`)
          return
        }
        await this._migrateMenu(menu)
      })
    }

    this.log('Menu migration finished!')
  }

  async _migrateMenu(menu) {
    this.info(`[MENU ${menu.id}] ${menu.handle} started...`)
    const mutation = `
      mutation menuCreate($input: MenuInput!) {
        menuCreate(input: $input) {
          menu {
            id
            handle
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `
    const variables = {
      input: {
        handle: menu.handle,
        title: menu.title,
        items: menu.items.map(item => ({
          title: item.title,
          url: item.url,
          type: item.type
        }))
      }
    }
    const response = await this.destination.graphql(mutation, variables)
    if (response.data.menuCreate.userErrors.length > 0) {
      throw new Error(`[MENU ${menu.id}] Failed to create: ${response.data.menuCreate.userErrors[0].message}`)
    } else {
      this.info(`[MENU ${menu.id}] duplicated. New id is ${response.data.menuCreate.menu.id}.`)
    }
  }

  async _deleteMenu(menuId) {
    const mutation = `
      mutation menuDelete($id: ID!) {
        menuDelete(id: $id) {
          deletedMenuId
          userErrors {
            field
            message
          }
        }
      }
    `
    const variables = {
      id: menuId
    }
    const response = await this.destination.graphql(mutation, variables)
    if (response.data.menuDelete.userErrors.length > 0) {
      this.error(`Failed to delete menu ${menuId}: ${response.data.menuDelete.userErrors[0].message}`)
    }
  }
}

module.exports = Migrator;