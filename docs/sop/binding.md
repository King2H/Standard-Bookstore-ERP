# Binding: standard operating procedure

How a shop sells binding, follows the job to the binder and back, and hands it over, and
how the money is counted. It describes what the bookstore does (#169, #203, #249; owner
decisions recorded there). Written for #267 (owner decision a, 2026-11-12).

## The words

| Word | What it is |
|---|---|
| **Book price** | What the book sells for: its branch price, else its default price. Binding never changes it. |
| **Binding service** | A kind of binding the shop offers (Catalog → Services), e.g. "Leather binding". |
| **Fee** | What the customer pays to bind **one copy**. It is its own line on the sale, beside the book. The shop sets a fee; a branch may set its own. |
| **Standard cost** | What the binder is **expected** to charge for one copy. It is the binding's cost in gross profit when it is sold. |
| **Actual cost** | What the binder **did** charge, entered when the job comes back. |
| **Binding cost difference** | Actual cost less standard cost, counted on the day the job comes back, below gross profit. |
| **Turnaround** | Days from the sale until the binding is ready: the ready date the customer is given. |
| **Job** | One binding on one sale line, numbered SVC-YYYYMMDD-NNNN, on the Binding Jobs page. |

## Setting up (Admin or Manager)

1. Catalog → Services → **New service**: a code, a name, the cover it produces, the fee,
   the standard cost and the turnaround. Tick **A sale may discount the fee** only if a
   cashier may discount it.
2. A branch that charges differently sets its own fee on the service (Branch fee).
3. Binding is offered at the counter once at least one service is active.

## At the sale

Binding can be added to a counter sale (POS), a customer order, or a book an exchange
gives out.

1. Choose a **named customer with a phone number**: the shop calls them when it is ready.
   A walk-in sale cannot carry a binding.
2. Add the book, then **+ Binding** on its line. Find the service by typing its name.
3. Say how many of the line's copies are bound (one up to the line's quantity).
4. A discount on the fee only where the service allows it, within the cashier's line
   discount limit. An exchange gives no discount on the fee.
5. The sale total is the books plus the fees. The receipt shows the binding as its own
   line. A job is opened for each bound line, status **Requested**, with its ready date.

## The job (Sales → Binding Jobs)

The board lists the branch's jobs, the oldest ready date first, with the customer's phone.
Search by job number, customer name, code or whole phone number, book title, or the sale's
number (POS-, ORD-, EXC-). Staff with access to all branches can look at another branch's
board; its jobs are moved on from that branch.

| Step | Button | Who | What happens |
|---|---|---|---|
| Requested → At binder | **Sent to binder** | Anyone who sells | The copies leave for the binder. |
| At binder → Ready | **Back and ready** | Anyone who sells | Enter the binder's **actual cost**. The selling staff are told in the app; call the customer. |
| Ready → Collected | **Collected** | Anyone who sells | The customer takes the bound copies (counter sale or exchange). |
| Ready → Collected (order) | — | — | Goes with the order: it is collected when the order is delivered. An order is delivered once its jobs are ready. |

A job past its ready date and not yet ready shows as **Overdue**; "Overdue only" lists them.

## When something changes

- **The customer cancels before the copies go to the binder** (status Requested): a
  Manager or Admin presses **Cancel binding** and gives the reason. The fee goes back the
  way it was paid. On an exchange it goes against what the customer still owes, then to
  store credit. After Requested, a binding cannot be cancelled.
- **A bound copy comes back defective**: a Manager or Admin takes it back through
  **Returns**, with the reason. The book and its fee are refunded, the copy goes to damaged
  stock at its cost, and the binding's cost is a loss. Unbound copies of the same sale
  are returned as any book.
- **Voiding a sale or cancelling an order** gives the fee back while its jobs are still
  Requested. Once a job has gone to the binder, the sale or order can no longer be voided
  or cancelled.

## How the money is counted (a worked example)

A customer buys a book at **300.00** (cost 180.00) and has it bound in leather: fee
**120.00**, standard cost **70.00**. The binder later charges **85.00**.

| | Day of the sale | Day the job comes back |
|---|---|---|
| Sale total | 420.00 (book 300.00 + binding 120.00) | — |
| Net sales | 420.00: book sales 300.00, service income 120.00 | — |
| Cost of the sale | 250.00: book 180.00 + binding at standard cost 70.00 | — |
| Gross profit | 170.00 | — |
| Binding cost difference | — | 15.00 (85.00 − 70.00) |
| Net profit effect | 170.00 | −15.00 |

The sales report and the dashboard show service income apart from book sales, and the
binding cost difference below gross profit. Staff who see costs see the binder's actual
cost on the job.

## Good practice

- Keep the standard cost close to what the binder charges, so the difference stays small;
  review it when the binder's prices change.
- Send jobs to the binder the same day, and check **Overdue only** every morning.
- Call the customer when a job is ready; the phone is on the board.
