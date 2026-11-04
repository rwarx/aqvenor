using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace AIClient.Infrastructure.Database.Migrations;

[DbContext(typeof(AIClientDbContext))]
[Migration("20261104100000_UniqueMessageSequence")]
public sealed class UniqueMessageSequence : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            WITH ordered AS (
              SELECT Id, ROW_NUMBER() OVER (PARTITION BY ConversationId ORDER BY SequenceNumber, CreatedAt, Id) - 1 AS seq
              FROM Messages
            )
            UPDATE Messages SET SequenceNumber = (SELECT seq FROM ordered WHERE ordered.Id = Messages.Id);
            """);
        migrationBuilder.DropIndex("IX_Messages_ConversationId_SequenceNumber", "Messages");
        migrationBuilder.CreateIndex("IX_Messages_ConversationId_SequenceNumber", "Messages", new[] { "ConversationId", "SequenceNumber" }, unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex("IX_Messages_ConversationId_SequenceNumber", "Messages");
        migrationBuilder.CreateIndex("IX_Messages_ConversationId_SequenceNumber", "Messages", new[] { "ConversationId", "SequenceNumber" });
    }
}
