/**
 * Única puerta a una colección de negocio. Inyecta `tenantId` en todo filtro, inserción
 * y agregación, y no expone borrados masivos ni consultas sin filtro. Si una consulta
 * trae su propio `tenantId`, se rechaza: el aislamiento no se negocia por llamada.
 */
export class TenantCollection {
  #collection;
  #tenantId;

  constructor(collection, tenantId) {
    this.#collection = collection;
    this.#tenantId = tenantId;
  }

  #scoped(filter = {}) {
    if ('tenantId' in filter) {
      throw new Error('el filtro no puede traer tenantId: lo inyecta TenantCollection');
    }
    return { ...filter, tenantId: this.#tenantId };
  }

  find(filter = {}, options) {
    return this.#collection.find(this.#scoped(filter), options);
  }

  findOne(filter = {}, options) {
    return this.#collection.findOne(this.#scoped(filter), options);
  }

  countDocuments(filter = {}, session) {
    return this.#collection.countDocuments(this.#scoped(filter), session ? { session } : undefined);
  }

  insertOne(doc, session) {
    if ('tenantId' in doc) {
      throw new Error('el documento no puede traer tenantId: lo inyecta TenantCollection');
    }
    return this.#collection.insertOne({ ...doc, tenantId: this.#tenantId }, session ? { session } : undefined);
  }

  updateOne(filter, update, options = {}) {
    return this.#collection.updateOne(this.#scoped(filter), update, options);
  }

  findOneAndUpdate(filter, update, options = {}) {
    return this.#collection.findOneAndUpdate(this.#scoped(filter), update, {
      ...options,
      includeResultMetadata: false,
    });
  }

  aggregate(pipeline, session) {
    return this.#collection.aggregate(
      [{ $match: { tenantId: this.#tenantId } }, ...pipeline],
      session ? { session } : undefined,
    );
  }
}
