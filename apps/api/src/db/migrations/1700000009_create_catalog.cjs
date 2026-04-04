'use strict';

exports.shorthands = undefined;

exports.up = function (pgm) {

  // ── authors ────────────────────────────────────────────────────────────────
  // Relational entity for deduplication and reporting.
  // normalized_name = lower(trim(name)) — used for case-insensitive upsert.
  pgm.createTable('authors', {
    id:              { type: 'serial', primaryKey: true },
    name:            { type: 'text', notNull: true, unique: true },
    normalized_name: { type: 'text', notNull: true, unique: true },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addIndex('authors', ['normalized_name']);

  // ── categories ─────────────────────────────────────────────────────────────
  // Relational entity for filtering, reporting, and autocomplete.
  pgm.createTable('categories', {
    id:              { type: 'serial', primaryKey: true },
    name:            { type: 'text', notNull: true, unique: true },
    normalized_name: { type: 'text', notNull: true, unique: true },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addIndex('categories', ['normalized_name']);

  // ── books ──────────────────────────────────────────────────────────────────
  // Core catalog entity.
  // authors_legacy TEXT[] kept for backward compatibility during transition;
  // authoritative data lives in book_authors.
  // search_vector covers title + author names (rebuilt on write via trigger).
  pgm.createTable('books', {
    id:              { type: 'serial', primaryKey: true },
    isbn:            { type: 'text', notNull: true, unique: true },
    title:           { type: 'text', notNull: true },
    genre:           { type: 'text' },
    publisher:       { type: 'text' },
    edition:         { type: 'text' },
    language:        { type: 'text' },
    format:          { type: 'text' },
    description:     { type: 'text' },
    cover_image_url: { type: 'text' },
    default_price:   { type: 'numeric(14,2)' },
    trade_value:     { type: 'numeric(14,2)' },
    is_active:       { type: 'boolean', notNull: true, default: true },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    search_vector:   { type: 'tsvector' },
  });
  pgm.addIndex('books', ['isbn']);
  pgm.addIndex('books', ['is_active']);
  pgm.sql(`CREATE INDEX books_search_vector_idx ON books USING GIN (search_vector)`);

  // ── book_authors (M:N) ─────────────────────────────────────────────────────
  pgm.createTable('book_authors', {
    book_id:   { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    author_id: { type: 'integer', notNull: true, references: 'authors(id)', onDelete: 'CASCADE' },
    sort_order: { type: 'smallint', notNull: true, default: 0 },
  });
  pgm.addConstraint('book_authors', 'book_authors_pkey', 'PRIMARY KEY (book_id, author_id)');
  pgm.addIndex('book_authors', ['author_id']);

  // ── book_categories (M:N) ─────────────────────────────────────────────────
  pgm.createTable('book_categories', {
    book_id:     { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    category_id: { type: 'integer', notNull: true, references: 'categories(id)', onDelete: 'CASCADE' },
  });
  pgm.addConstraint('book_categories', 'book_categories_pkey', 'PRIMARY KEY (book_id, category_id)');
  pgm.addIndex('book_categories', ['category_id']);

  // ── book_tags ──────────────────────────────────────────────────────────────
  pgm.createTable('book_tags', {
    book_id: { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    tag:     { type: 'text', notNull: true },
  });
  pgm.addConstraint('book_tags', 'book_tags_pkey', 'PRIMARY KEY (book_id, tag)');

  // ── book_branch_prices ─────────────────────────────────────────────────────
  pgm.createTable('book_branch_prices', {
    book_id:   { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    branch_id: { type: 'integer', notNull: true, references: 'branches(id)', onDelete: 'CASCADE' },
    price:     { type: 'numeric(14,2)', notNull: true },
  });
  pgm.addConstraint('book_branch_prices', 'book_branch_prices_pkey', 'PRIMARY KEY (book_id, branch_id)');

  // ── book_edit_history ──────────────────────────────────────────────────────
  pgm.createTable('book_edit_history', {
    id:         { type: 'bigserial', primaryKey: true },
    book_id:    { type: 'integer', notNull: true, references: 'books(id)', onDelete: 'CASCADE' },
    field_name: { type: 'text', notNull: true },
    old_value:  { type: 'text' },
    new_value:  { type: 'text' },
    changed_by: { type: 'integer', notNull: true },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addIndex('book_edit_history', ['book_id']);

  // ── search_vector update function + trigger ────────────────────────────────
  // Rebuilds tsvector from title + all author names whenever a book is written.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION books_search_vector_update() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := (
        SELECT to_tsvector('english',
          coalesce(NEW.title, '') || ' ' ||
          coalesce(string_agg(a.name, ' '), '')
        )
        FROM book_authors ba
        JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = NEW.id
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER books_search_vector_trigger
    BEFORE INSERT OR UPDATE ON books
    FOR EACH ROW EXECUTE FUNCTION books_search_vector_update();
  `);

  // ── Seed: 8 sample books ───────────────────────────────────────────────────
  pgm.sql(`
    -- Authors
    INSERT INTO authors (name, normalized_name) VALUES
      ('George Orwell',        'george orwell'),
      ('J.K. Rowling',         'j.k. rowling'),
      ('Frank Herbert',        'frank herbert'),
      ('Harper Lee',           'harper lee'),
      ('F. Scott Fitzgerald',  'f. scott fitzgerald'),
      ('J.R.R. Tolkien',       'j.r.r. tolkien'),
      ('Gabriel García Márquez','gabriel garcía márquez'),
      ('Aldous Huxley',        'aldous huxley')
    ON CONFLICT (normalized_name) DO NOTHING;

    -- Categories
    INSERT INTO categories (name, normalized_name) VALUES
      ('Fiction',          'fiction'),
      ('Classic',          'classic'),
      ('Science Fiction',  'science fiction'),
      ('Fantasy',          'fantasy'),
      ('Dystopian',        'dystopian'),
      ('Literary Fiction', 'literary fiction'),
      ('Magical Realism',  'magical realism')
    ON CONFLICT (normalized_name) DO NOTHING;

    -- Books
    INSERT INTO books (isbn, title, genre, publisher, language, format, default_price, trade_value, is_active)
    VALUES
      ('9780451524935', 'Nineteen Eighty-Four',          'Fiction',        'Secker & Warburg',    'English', 'Paperback', 12.99, 4.00, true),
      ('9780439708180', 'Harry Potter and the Sorcerer''s Stone', 'Fantasy','Scholastic',         'English', 'Hardcover', 19.99, 6.00, true),
      ('9780441013593', 'Dune',                          'Science Fiction','Chilton Books',       'English', 'Paperback', 14.99, 5.00, true),
      ('9780061743528', 'To Kill a Mockingbird',         'Fiction',        'J. B. Lippincott',    'English', 'Paperback', 11.99, 3.50, true),
      ('9780743273565', 'The Great Gatsby',              'Fiction',        'Charles Scribner''s', 'English', 'Paperback', 10.99, 3.00, true),
      ('9780618640157', 'The Lord of the Rings',         'Fantasy',        'Allen & Unwin',       'English', 'Hardcover', 29.99, 9.00, true),
      ('9780060883287', 'One Hundred Years of Solitude', 'Fiction',        'Harper & Row',        'English', 'Paperback', 13.99, 4.50, true),
      ('9780060850524', 'Brave New World',               'Science Fiction','Chatto & Windus',     'English', 'Paperback', 11.99, 3.50, true)
    ON CONFLICT (isbn) DO NOTHING;

    -- book_authors
    INSERT INTO book_authors (book_id, author_id, sort_order)
    SELECT b.id, a.id, 0 FROM books b, authors a
    WHERE (b.isbn='9780451524935' AND a.normalized_name='george orwell')
       OR (b.isbn='9780439708180' AND a.normalized_name='j.k. rowling')
       OR (b.isbn='9780441013593' AND a.normalized_name='frank herbert')
       OR (b.isbn='9780061743528' AND a.normalized_name='harper lee')
       OR (b.isbn='9780743273565' AND a.normalized_name='f. scott fitzgerald')
       OR (b.isbn='9780618640157' AND a.normalized_name='j.r.r. tolkien')
       OR (b.isbn='9780060883287' AND a.normalized_name='gabriel garcía márquez')
       OR (b.isbn='9780060850524' AND a.normalized_name='aldous huxley')
    ON CONFLICT DO NOTHING;

    -- book_categories
    INSERT INTO book_categories (book_id, category_id)
    SELECT b.id, c.id FROM books b, categories c
    WHERE (b.isbn='9780451524935' AND c.normalized_name IN ('fiction','classic','dystopian'))
       OR (b.isbn='9780439708180' AND c.normalized_name IN ('fantasy','fiction'))
       OR (b.isbn='9780441013593' AND c.normalized_name IN ('science fiction','classic'))
       OR (b.isbn='9780061743528' AND c.normalized_name IN ('fiction','classic','literary fiction'))
       OR (b.isbn='9780743273565' AND c.normalized_name IN ('fiction','classic','literary fiction'))
       OR (b.isbn='9780618640157' AND c.normalized_name IN ('fantasy','classic'))
       OR (b.isbn='9780060883287' AND c.normalized_name IN ('fiction','magical realism','literary fiction'))
       OR (b.isbn='9780060850524' AND c.normalized_name IN ('science fiction','classic','dystopian'))
    ON CONFLICT DO NOTHING;

    -- book_tags
    INSERT INTO book_tags (book_id, tag)
    SELECT b.id, t.tag FROM books b, (VALUES
      ('9780451524935','totalitarianism'),('9780451524935','surveillance'),
      ('9780439708180','magic'),('9780439708180','coming-of-age'),
      ('9780441013593','space-opera'),('9780441013593','politics'),
      ('9780061743528','race'),('9780061743528','justice'),
      ('9780743273565','jazz-age'),('9780743273565','american-dream'),
      ('9780618640157','epic'),('9780618640157','mythology'),
      ('9780060883287','solitude'),('9780060883287','family'),
      ('9780060850524','technology'),('9780060850524','society')
    ) AS t(isbn, tag)
    WHERE b.isbn = t.isbn
    ON CONFLICT DO NOTHING;

    -- Rebuild search_vectors for seeded books
    UPDATE books SET title = title;
  `);
};

exports.down = function (pgm) {
  pgm.sql(`DROP TRIGGER IF EXISTS books_search_vector_trigger ON books`);
  pgm.sql(`DROP FUNCTION IF EXISTS books_search_vector_update()`);
  pgm.dropTable('book_edit_history');
  pgm.dropTable('book_branch_prices');
  pgm.dropTable('book_tags');
  pgm.dropTable('book_categories');
  pgm.dropTable('book_authors');
  pgm.dropTable('books');
  pgm.dropTable('categories');
  pgm.dropTable('authors');
};
